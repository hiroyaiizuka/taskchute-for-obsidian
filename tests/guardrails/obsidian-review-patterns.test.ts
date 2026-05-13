import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const SRC_ROOT = path.join(ROOT, 'src')

const rawBrowserTimerPatterns = [
  {
    name: 'raw setTimeout',
    regex: /^(?!\s*setTimeout\s*[:?])(?!\s*setTimeout\s*\(.*\)\s*:).*(?<!\.)\bsetTimeout\(/,
  },
  {
    name: 'raw clearTimeout',
    regex: /^(?!\s*clearTimeout\s*[:?])(?!\s*clearTimeout\s*\(.*\)\s*:).*(?<!\.)\bclearTimeout\(/,
  },
  {
    name: 'raw setInterval',
    regex: /^(?!\s*setInterval\s*[:?])(?!\s*setInterval\s*\(.*\)\s*:).*(?<!\.)\bsetInterval\(/,
  },
  {
    name: 'raw clearInterval',
    regex: /^(?!\s*clearInterval\s*[:?])(?!\s*clearInterval\s*\(.*\)\s*:).*(?<!\.)\bclearInterval\(/,
  },
]

function collectFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate))
      continue
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

function findMatches(
  files: string[],
  patterns: Array<{ name: string; regex: RegExp }>,
): string[] {
  const matches: string[] = []
  for (const filePath of files) {
    const relative = path.relative(ROOT, filePath)
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          matches.push(`${relative}:${index + 1} ${pattern.name}`)
        }
      }
    }
  }
  return matches
}

function findDuplicateCssBlocks(css: string): string[] {
  const blocks = new Map<string, string[]>()
  const blockPattern = /([^{}@][^{}]*)\{([^{}]*)\}/g
  let match: RegExpExecArray | null

  while ((match = blockPattern.exec(css)) !== null) {
    const selector = match[1].trim()
    if (!selector || /^\d+%$/.test(selector)) continue
    const body = match[2].trim().replace(/\s+/g, ' ')
    const line = css.slice(0, match.index).split(/\r?\n/).length
    const key = `${selector}{${body}}`
    const entries = blocks.get(key) ?? []
    entries.push(`${line}: ${selector.replace(/\s+/g, ' ')}`)
    blocks.set(key, entries)
  }

  return Array.from(blocks.values())
    .filter((entries) => entries.length > 1)
    .map((entries) => entries.join(' | '))
}

describe('Obsidian review guardrails', () => {
  test('source avoids global DOM creation and raw browser timers', () => {
    const files = collectFiles(SRC_ROOT, (filePath) => filePath.endsWith('.ts'))
    const offenders = findMatches(files, [
      { name: 'global document access', regex: /\bdocument\./ },
      { name: 'document.createElement', regex: /\bdocument\.createElement(?:NS)?\(/ },
      ...rawBrowserTimerPatterns,
      { name: 'window timer', regex: /\bwindow\.(?:setTimeout|clearTimeout|setInterval|clearInterval)\(/ },
      { name: 'window.open', regex: /\bwindow\.open\(/ },
      { name: 'globalThis', regex: /\bglobalThis\b/ },
      { name: 'localStorage language', regex: /localStorage\?*\.getItem\(["']language["']\)/ },
    ])

    expect(offenders).toEqual([])
  })

  test('raw timer guardrails catch line-start calls while ignoring timer type fields', () => {
    const setTimeoutPattern = rawBrowserTimerPatterns.find((pattern) => pattern.name === 'raw setTimeout')
    const clearTimeoutPattern = rawBrowserTimerPatterns.find((pattern) => pattern.name === 'raw clearTimeout')
    const setIntervalPattern = rawBrowserTimerPatterns.find((pattern) => pattern.name === 'raw setInterval')
    const clearIntervalPattern = rawBrowserTimerPatterns.find((pattern) => pattern.name === 'raw clearInterval')

    expect(setTimeoutPattern?.regex.test('setTimeout(() => undefined, 0)')).toBe(true)
    expect(clearTimeoutPattern?.regex.test('  clearTimeout(timer)')).toBe(true)
    expect(setIntervalPattern?.regex.test('setInterval(tick, 1000)')).toBe(true)
    expect(clearIntervalPattern?.regex.test('  clearInterval(intervalId)')).toBe(true)

    expect(setTimeoutPattern?.regex.test('  setTimeout: jest.Mock<number, [TimerHandler, number?]>')).toBe(false)
    expect(clearTimeoutPattern?.regex.test('  clearTimeout?: (timer: number) => void')).toBe(false)
    expect(setIntervalPattern?.regex.test('  setInterval(callback: () => void, intervalMs: number): StableIntervalId')).toBe(false)
    expect(clearIntervalPattern?.regex.test('  clearInterval(intervalId: StableIntervalId): void')).toBe(false)
    expect(setTimeoutPattern?.regex.test('timerWindow.setTimeout(() => undefined, 0)')).toBe(false)
    expect(clearIntervalPattern?.regex.test('stableTimerWindow.clearInterval(intervalId)')).toBe(false)
  })

  test('styles avoid review-unfriendly CSS patterns', () => {
    const stylesPath = path.join(ROOT, 'styles.css')
    const offenders = findMatches([stylesPath], [
      { name: 'unexpected !important', regex: /!important\b/ },
      { name: '3-digit hex color', regex: /#[0-9A-Fa-f]{3}\b/ },
      { name: 'browser multicolumn feature', regex: /(^|\s)column-(?:count|gap|width)\s*:/ },
      { name: 'redundant two-value shorthand', regex: /:\s*(\d+(?:px|rem|em|%)?|0)\s+\1[;)]/ },
      { name: 'redundant shorthand', regex: /:\s*(?:\d+(?:px|rem|em|%)?|0)\s+(\d+(?:px|rem|em|%)?|0)\s+(?:\d+(?:px|rem|em|%)?|0)\s+\1[;)]/ },
    ])

    expect(offenders).toEqual([])
  })

  test('styles do not repeat identical selector blocks', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')

    expect(findDuplicateCssBlocks(css)).toEqual([])
  })

  test('release root and direct dependencies stay review-safe', () => {
    const rootEntries = fs.readdirSync(ROOT)
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(rootEntries.filter((entry) => /^release-.*\.zip$/.test(entry))).toEqual([])
    expect(packageJson.dependencies?.['builtin-modules']).toBeUndefined()
    expect(packageJson.devDependencies?.['builtin-modules']).toBeUndefined()
  })

  test('release workflow generates artifact attestations for published assets', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/release.yml'),
      'utf8',
    )

    expect(workflow).toMatch(/id-token:\s*write/)
    expect(workflow).toMatch(/attestations:\s*write/)
    expect(workflow).toContain('uses: actions/attest-build-provenance@v2')
    expect(workflow).not.toContain('uses: actions/attest@v4')
    expect(workflow).toContain('subject-path: |')
    expect(workflow).not.toContain('${{ steps.prep.outputs.zip }}')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/main.js')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/manifest.json')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/styles.css')
  })

  test('release workflow publishes only Obsidian-supported release assets', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/release.yml'),
      'utf8',
    )

    expect(workflow).not.toMatch(/\bzip\s+-r\b/)
    expect(workflow).not.toMatch(/release-\$\{?TAG\}?\.zip/)
    expect(workflow).not.toContain('echo "zip=')
    expect(workflow).not.toContain('${{ steps.prep.outputs.zip }}')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/main.js')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/manifest.json')
    expect(workflow).toContain('${{ steps.prep.outputs.dir }}/styles.css')
  })
})
