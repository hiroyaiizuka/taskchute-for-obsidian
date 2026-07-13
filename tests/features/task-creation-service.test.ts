import { Notice, TFile } from 'obsidian'
import { TaskCreationService } from '../../src/features/core/services/TaskCreationService'
import { readAiTaskConfig } from '../../src/features/ai-task/services/AiTaskFrontmatterReader'
import { extractPromptSection } from '../../src/features/ai-task/services/PromptExtractor'
import type { TaskChutePluginLike } from '../../src/types'
import { parse as parseYaml } from 'yaml'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

describe('TaskCreationService', () => {
  const createPlugin = () => {
    const file = new TFile()
    file.path = 'TaskChute/Task/My Task.md'
    file.basename = 'My Task'
    file.extension = 'md'

    const plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create: jest.fn().mockResolvedValue(file),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskChutePluginLike & { app: { vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock } } }

    return plugin
  }

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
  })

  test('createTaskFile writes taskId into frontmatter', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '08:30')

    expect(plugin.app.vault.create).toHaveBeenCalledTimes(1)
    const content = plugin.app.vault.create.mock.calls[0]?.[1] as string
    expect(content).toContain('taskId: "tc-task-')
    expect(content).toContain('target_date: "2025-11-16"')
    expect(content).toContain('scheduled_time: "08:30"')
  })

  test('createTaskFile uses provided taskId when supplied', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', undefined, {
      taskId: 'tc-task-restore',
    })

    const lastCall = plugin.app.vault.create.mock.calls[plugin.app.vault.create.mock.calls.length - 1]
    const content = lastCall?.[1] as string
    expect(content).toContain('taskId: "tc-task-restore"')
  })

  test('createTaskFile writes reminder_time when supplied', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '09:00', {
      reminderTime: '08:55',
    })

    const lastCall = plugin.app.vault.create.mock.calls[plugin.app.vault.create.mock.calls.length - 1]
    const content = lastCall?.[1] as string
    expect(content).toContain('scheduled_time: "09:00"')
    expect(content).toContain('reminder_time: "08:55"')
  })

  test('createTaskFile emits NO ai fields without the aiTask option', async () => {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)

    await service.createTaskFile('My Task', '2025-11-16', '08:30')

    const content = plugin.app.vault.create.mock.calls[0]?.[1] as string
    expect(content).not.toContain('ai_task')
    expect(content).not.toContain('## Prompt')
  })
})

/**
 * Minimal parser for the frontmatter block this service emits (scalars,
 * booleans, and block lists of double-quoted strings). The emitted format is
 * fully controlled by createTaskFile, so this subset is exact.
 */
function parseEmittedFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('content has no frontmatter block')
  const result: Record<string, unknown> = {}
  let currentListKey: string | null = null
  for (const line of match[1].split('\n')) {
    const item = line.match(/^ {2}- (.*)$/)
    if (item && currentListKey !== null) {
      ;(result[currentListKey] as unknown[]).push(parseEmittedScalar(item[1]))
      continue
    }
    const kv = line.match(/^([A-Za-z_]+):(.*)$/)
    if (!kv) continue
    const rest = kv[2].trim()
    if (rest === '') {
      result[kv[1]] = []
      currentListKey = kv[1]
      continue
    }
    currentListKey = null
    result[kv[1]] = parseEmittedScalar(rest)
  }
  return result
}

function parseEmittedScalar(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return raw
}

function parseRealFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) throw new Error('content has no frontmatter block')
  const parsed = parseYaml(match[1])
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter is not a YAML mapping')
  }
  return parsed as Record<string, unknown>
}

describe('TaskCreationService AI task notes (U3)', () => {
  const createPlugin = () => {
    const file = new TFile()
    file.path = 'TaskChute/Task/AI Task.md'
    file.basename = 'AI Task'
    file.extension = 'md'

    return {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create: jest.fn().mockResolvedValue(file),
        },
      },
      pathManager: {
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as TaskChutePluginLike & {
      app: { vault: { getAbstractFileByPath: jest.Mock; create: jest.Mock } }
    }
  }

  async function createdContent(
    options: Parameters<TaskCreationService['createTaskFile']>[3],
    scheduledTime?: string,
  ): Promise<string> {
    const plugin = createPlugin()
    const service = new TaskCreationService(plugin)
    await service.createTaskFile('AI Task', '2025-11-16', scheduledTime, options)
    return plugin.app.vault.create.mock.calls[0]?.[1] as string
  }

  test('round-trips host, args, cwd, and prompt through the real reader and extractor', async () => {
    const content = await createdContent({
      aiTask: {
        host: 'codex',
        args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--model=o3'],
        cwd: '/Users/me/project',
        prompt: 'Review the PR\nThen summarize the findings',
      },
    })

    const frontmatter = parseRealFrontmatter(content)
    expect(frontmatter['ai_task']).toBe(true)

    const config = readAiTaskConfig(frontmatter)
    expect(config).toEqual({
      host: 'codex',
      args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--model=o3'],
      cwd: '/Users/me/project',
    })

    expect(extractPromptSection(content)).toBe(
      'Review the PR\nThen summarize the findings',
    )
  })

  test('omits args and cwd keys when empty and keeps host claude', async () => {
    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt: 'Say hello' },
    })

    expect(content).not.toContain('ai_task_args')
    expect(content).not.toContain('ai_task_cwd')

    const config = readAiTaskConfig(parseEmittedFrontmatter(content))
    expect(config).toEqual({ host: 'claude', args: [], cwd: undefined })
    expect(extractPromptSection(content)).toBe('Say hello')
  })

  test('round-trips model and reasoning argv tokens without shell parsing', async () => {
    const args = [
      '--model=gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="high"',
    ]
    const content = await createdContent({
      aiTask: { host: 'codex', args, prompt: 'Investigate deeply' },
    })

    expect(readAiTaskConfig(parseRealFrontmatter(content))).toEqual({
      host: 'codex',
      args,
      cwd: undefined,
    })
  })

  test('writes an empty "## Prompt" section for an empty prompt', async () => {
    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt: '' },
    })

    expect(content).toContain('\n## Prompt\n')
    // An empty section extracts as null — the terminal run mode treats that
    // as a plain REPL start.
    expect(extractPromptSection(content)).toBeNull()
    expect(readAiTaskConfig(parseEmittedFrontmatter(content))).not.toBeNull()
  })

  test('round-trips a prompt containing markdown H1/H2 heading lines', async () => {
    // Carried WARNING regression: a pasted prompt with "# Overview" used to
    // truncate at extraction because the extractor stops at H1/H2 lines.
    // The writer escapes hash-leading lines; the extractor unescapes them.
    const prompt = [
      'Fix the docs.',
      '# Overview',
      'It has two parts:',
      '## Steps',
      '1. read',
      '### keep h3 as-is',
      '#tag mention',
      '\\# already escaped by the user',
    ].join('\n')

    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt },
    })

    expect(extractPromptSection(content)).toBe(prompt)
    // The raw note keeps no live H1/H2 inside the section body.
    expect(content).toContain('\\# Overview')
    expect(content).toContain('\\## Steps')
    const promptSectionStart = content.indexOf('## Prompt')
    const afterSection = content.slice(promptSectionStart + '## Prompt'.length)
    expect(afterSection).not.toMatch(/^#{1,2}[ \t]+\S/m)
  })

  test('round-trips indented (1-3 space) hash lines that CommonMark still parses as headings', async () => {
    // Carried WARNING regression: Obsidian's heading cache follows CommonMark
    // and recognizes ATX headings indented by up to three spaces, so a prompt
    // line like '  # item' written unescaped was cached as an H1 and
    // truncated the extraction there. Four spaces are indented code: never a
    // heading, never escaped.
    const prompt = [
      'Steps:',
      ' # one-space heading',
      '  ## two-space heading',
      '   ### three-space h3',
      '    # four spaces is code, not a heading',
      '  \\# indented pre-escaped',
    ].join('\n')

    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt },
    })

    expect(extractPromptSection(content)).toBe(prompt)
    // The raw note keeps no live (cache-visible) H1/H2 inside the section.
    const promptSectionStart = content.indexOf('## Prompt')
    const afterSection = content.slice(promptSectionStart + '## Prompt'.length)
    expect(afterSection).not.toMatch(/^ {0,3}#{1,2}[ \t]+\S/m)
    // The four-space line stays byte-identical (no escape added).
    expect(content).toContain('\n    # four spaces is code, not a heading\n')
  })

  test('round-trips prompt outer whitespace exactly', async () => {
    const prompt = '\n    indented first line  \nlast line  \n'
    const content = await createdContent({
      aiTask: { host: 'claude', args: [], prompt },
    })

    expect(extractPromptSection(content)).toBe(prompt)
  })

  test('emits YAML-safe argv and cwd scalars that round-trip through a real parser', async () => {
    const args = [
      'line\nbreak',
      'crlf\r\nbreak',
      'tab\tvalue',
      'nul\u0000value',
      'bell\u0007value',
      'escape\u001Bvalue',
      'del\u007Fvalue',
      'c1\u0085value',
      'line-separator\u2028value',
      'paragraph-separator\u2029value',
      'quote" and slash\\',
    ]
    const cwd = '/tmp/line\nbreak\t\u0000"\\'
    const content = await createdContent({
      aiTask: { host: 'codex', args, cwd, prompt: 'Go' },
    })

    const frontmatter = parseRealFrontmatter(content)
    expect(readAiTaskConfig(frontmatter)).toEqual({
      host: 'codex',
      args,
      cwd,
    })

    const rawFrontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    expect(rawFrontmatter).toContain('"line\\nbreak"')
    expect(rawFrontmatter).toContain('"nul\\u0000value"')
    expect(rawFrontmatter).toContain('"c1\\u0085value"')
    expect(rawFrontmatter).toContain('"line-separator\\u2028value"')
    const rawControlCharacters = Array.from(rawFrontmatter).filter((character) => {
      const codePoint = character.codePointAt(0) ?? -1
      return (
        (codePoint >= 0 && codePoint <= 9) ||
        (codePoint >= 11 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      )
    })
    expect(rawControlCharacters).toEqual([])
  })

  test('keeps the standard fields (target_date, taskId, scheduled_time, heading) intact', async () => {
    const content = await createdContent(
      { aiTask: { host: 'claude', args: ['--max-turns', '1'], prompt: 'Go' } },
      '09:30',
    )

    expect(content).toContain('target_date: "2025-11-16"')
    expect(content).toContain('taskId: "tc-task-')
    expect(content).toContain('scheduled_time: "09:30"')
    expect(content).toContain('\n# AI Task\n')
    // The prompt section sits AFTER the H1 heading.
    expect(content.indexOf('## Prompt')).toBeGreaterThan(content.indexOf('# AI Task'))
  })
})
