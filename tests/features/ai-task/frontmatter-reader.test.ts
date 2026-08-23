import fs from 'fs'
import path from 'path'
import { readAiTaskConfig } from '../../../src/features/ai-task/services/AiTaskFrontmatterReader'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.getOwnPropertyNames(value).forEach((prop) => {
      deepFreeze((value as Record<string, unknown>)[prop])
    })
    Object.freeze(value)
  }
  return value
}

describe('readAiTaskConfig', () => {
  test('returns null for null or undefined frontmatter', () => {
    expect(readAiTaskConfig(null)).toBeNull()
    expect(readAiTaskConfig(undefined)).toBeNull()
  })

  test('returns null when ai_task is missing', () => {
    expect(readAiTaskConfig({ name: 'Some task' })).toBeNull()
  })

  test('returns null unless ai_task is strictly boolean true', () => {
    expect(readAiTaskConfig({ ai_task: 'true' })).toBeNull()
    expect(readAiTaskConfig({ ai_task: 1 })).toBeNull()
    expect(readAiTaskConfig({ ai_task: {} })).toBeNull()
    expect(readAiTaskConfig({ ai_task: [] })).toBeNull()
    expect(readAiTaskConfig({ ai_task: false })).toBeNull()
    expect(readAiTaskConfig({ ai_task: null })).toBeNull()
  })

  test('returns defaults when ai_task is true', () => {
    const config = readAiTaskConfig({ ai_task: true })
    expect(config).toEqual({ host: 'claude', args: [], cwd: undefined })
  })

  test('accepts codex as host', () => {
    const config = readAiTaskConfig({ ai_task: true, ai_task_host: 'codex' })
    expect(config?.host).toBe('codex')
  })

  test('normalizes host casing and surrounding whitespace', () => {
    const config = readAiTaskConfig({ ai_task: true, ai_task_host: ' Codex ' })
    expect(config?.host).toBe('codex')
  })

  test('falls back to claude for unknown host values', () => {
    expect(readAiTaskConfig({ ai_task: true, ai_task_host: 'gemini' })?.host).toBe('claude')
    expect(readAiTaskConfig({ ai_task: true, ai_task_host: 42 })?.host).toBe('claude')
    expect(readAiTaskConfig({ ai_task: true, ai_task_host: null })?.host).toBe('claude')
  })

  test('tokenizes string args on whitespace', () => {
    const config = readAiTaskConfig({
      ai_task: true,
      ai_task_args: '--max-turns 1 --model sonnet',
    })
    expect(config?.args).toEqual(['--max-turns', '1', '--model', 'sonnet'])
  })

  test('tokenizes string args honoring double quotes', () => {
    const config = readAiTaskConfig({
      ai_task: true,
      ai_task_args: '--append-system-prompt "hello world" --max-turns 1',
    })
    expect(config?.args).toEqual([
      '--append-system-prompt',
      'hello world',
      '--max-turns',
      '1',
    ])
  })

  test('tokenizes string args honoring single quotes', () => {
    const config = readAiTaskConfig({
      ai_task: true,
      ai_task_args: "--flag 'a b c'",
    })
    expect(config?.args).toEqual(['--flag', 'a b c'])
  })

  test('keeps an explicitly quoted empty string as an argument', () => {
    const config = readAiTaskConfig({ ai_task: true, ai_task_args: '--flag ""' })
    expect(config?.args).toEqual(['--flag', ''])
  })

  test('collapses repeated whitespace between tokens', () => {
    const config = readAiTaskConfig({ ai_task: true, ai_task_args: '  -a   -b  ' })
    expect(config?.args).toEqual(['-a', '-b'])
  })

  test('keeps array args verbatim, dropping only non-strings', () => {
    // Array entries are literal argv tokens: an empty string pairs with a
    // preceding value flag (["--model", ""]) and must not be dropped, or the
    // dangling flag would consume the following token. Mirrors
    // tokenizeArgString, which preserves quoted empty tokens.
    const config = readAiTaskConfig({
      ai_task: true,
      ai_task_args: ['--max-turns', '1', 'two words kept together', 3, '', '  ', null],
    })
    expect(config?.args).toEqual([
      '--max-turns',
      '1',
      'two words kept together',
      '',
      '  ',
    ])
  })

  test('returns empty args for unsupported ai_task_args types', () => {
    expect(readAiTaskConfig({ ai_task: true, ai_task_args: 42 })?.args).toEqual([])
    expect(readAiTaskConfig({ ai_task: true, ai_task_args: {} })?.args).toEqual([])
  })

  test('passes through a non-empty ai_task_cwd string', () => {
    const config = readAiTaskConfig({
      ai_task: true,
      ai_task_cwd: '/Users/someone/projects/demo',
    })
    expect(config?.cwd).toBe('/Users/someone/projects/demo')
  })

  test('ignores empty or non-string ai_task_cwd', () => {
    expect(readAiTaskConfig({ ai_task: true, ai_task_cwd: '' })?.cwd).toBeUndefined()
    expect(readAiTaskConfig({ ai_task: true, ai_task_cwd: '   ' })?.cwd).toBeUndefined()
    expect(readAiTaskConfig({ ai_task: true, ai_task_cwd: 7 })?.cwd).toBeUndefined()
  })

  test('never mutates the input frontmatter (deep-frozen contract)', () => {
    const frontmatter = deepFreeze({
      ai_task: true,
      ai_task_host: 'codex',
      ai_task_args: ['--json'],
      ai_task_cwd: '/tmp/example',
      name: 'Frozen task',
    })
    expect(() => readAiTaskConfig(frontmatter)).not.toThrow()
    const config = readAiTaskConfig(frontmatter)
    expect(config).toEqual({ host: 'codex', args: ['--json'], cwd: '/tmp/example' })
    // Returned args must be a fresh array, not the frozen input reference
    expect(config?.args).not.toBe(frontmatter.ai_task_args)
  })
})

describe('ai-task task-note write guardrail', () => {
  const AI_TASK_ROOT = path.resolve(__dirname, '../../../src/features/ai-task')

  function collectTsFiles(root: string): string[] {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        files.push(...collectTsFiles(fullPath))
        continue
      }
      if (entry.isFile() && fullPath.endsWith('.ts')) {
        files.push(fullPath)
      }
    }
    return files
  }

  test('module exists', () => {
    expect(fs.existsSync(AI_TASK_ROOT)).toBe(true)
  })

  test('src/features/ai-task never writes task-note frontmatter or task notes', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []
    // AI-task code is read-only except for the two narrow writers below:
    // run logs, and the explicit user-driven existing-task settings editor.
    const MODIFY_ALLOWLIST = new Set([
      'services/AiTaskEditService.ts',
      'services/AiTaskLogWriter.ts',
    ])
    const patterns: Array<{ pattern: RegExp; allowlist?: Set<string> }> = [
      { pattern: /processFrontMatter\s*\(/u },
      { pattern: /vault\.modify\s*\(/u, allowlist: MODIFY_ALLOWLIST },
    ]

    collectTsFiles(AI_TASK_ROOT).forEach((filePath) => {
      const relative = path.relative(AI_TASK_ROOT, filePath)
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)
      lines.forEach((line, index) => {
        patterns.forEach(({ pattern, allowlist }) => {
          if (allowlist?.has(relative)) return
          if (pattern.test(line)) {
            offenders.push({ file: relative, line: index + 1, text: line.trim() })
          }
        })
      })
    })

    expect(offenders).toEqual([])
  })

  test('the log-writer vault.modify exemption stays confined to upsertRunLog', () => {
    const writerPath = path.join(AI_TASK_ROOT, 'services/AiTaskLogWriter.ts')
    const source = fs.readFileSync(writerPath, 'utf8')
    const occurrences = source.match(/vault\.modify\s*\(/gu) ?? []
    // Exactly one call site, and it must target the record's own log note.
    expect(occurrences).toHaveLength(1)
    expect(source).toContain('record.logNotePath')
    expect(source).not.toContain('processFrontMatter')
  })

  test('the task-editor vault.modify exemption stays confined to its selected file', () => {
    const editorPath = path.join(AI_TASK_ROOT, 'services/AiTaskEditService.ts')
    const source = fs.readFileSync(editorPath, 'utf8')
    const occurrences = source.match(/vault\.modify\s*\(/gu) ?? []
    expect(occurrences).toHaveLength(1)
    expect(source).toContain('await this.app.vault.modify(file, updated)')
    expect(source).not.toContain('processFrontMatter')
  })
})
