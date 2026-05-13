import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const SRC_ROOT = path.join(ROOT, 'src')

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

describe('Obsidian review guardrails', () => {
  test('source avoids global DOM creation and raw browser timers', () => {
    const files = collectFiles(SRC_ROOT, (filePath) => (
      filePath.endsWith('.ts')
      && path.relative(ROOT, filePath) !== 'src/utils/stableTimer.ts'
    ))
    const offenders = findMatches(files, [
      { name: 'document.createElement', regex: /\bdocument\.createElement(?:NS)?\(/ },
      { name: 'raw setTimeout', regex: /(?<!\.)\bsetTimeout\(/ },
      { name: 'raw clearTimeout', regex: /(?<!\.)\bclearTimeout\(/ },
      { name: 'raw setInterval', regex: /(?<!\.)\bsetInterval\(/ },
      { name: 'raw clearInterval', regex: /(?<!\.)\bclearInterval\(/ },
      { name: 'window timer', regex: /\bwindow\.(?:setTimeout|clearTimeout|setInterval|clearInterval)\(/ },
      { name: 'window.open', regex: /\bwindow\.open\(/ },
      { name: 'globalThis', regex: /\bglobalThis\b/ },
      { name: 'localStorage language', regex: /localStorage\?*\.getItem\(["']language["']\)/ },
    ])

    expect(offenders).toEqual([])
  })

  test('styles avoid review-unfriendly CSS patterns', () => {
    const stylesPath = path.join(ROOT, 'styles.css')
    const offenders = findMatches([stylesPath], [
      {
        name: 'unexpected !important',
        regex: /^(?!\s*(?:opacity:\s*(?:0|0\.8)|visibility:\s*visible)\s*!important;).*!important\b/,
      },
      { name: '3-digit hex color', regex: /#[0-9A-Fa-f]{3}\b/ },
      { name: 'browser multicolumn feature', regex: /(^|\s)column-(?:count|gap|width)\s*:/ },
      { name: 'redundant shorthand', regex: /:\s*(?:\d+(?:px|rem|em|%)?|0)\s+(\d+(?:px|rem|em|%)?|0)\s+(?:\d+(?:px|rem|em|%)?|0)\s+\1[;)]/ },
    ])

    expect(offenders).toEqual([])
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
})
