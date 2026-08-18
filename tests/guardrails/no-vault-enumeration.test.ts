import fs from 'fs'
import path from 'path'

const SRC_ROOT = path.resolve(__dirname, '../../src')

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

describe('vault enumeration guardrail', () => {
  test('source code does not enumerate the entire vault', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = []

    collectTsFiles(SRC_ROOT).forEach((filePath) => {
      const relative = path.relative(SRC_ROOT, filePath)
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)

      lines.forEach((line, index) => {
        if (/\.(getMarkdownFiles|getFiles|getAllLoadedFiles)(?:\?\.)?\s*\(/u.test(line)) {
          offenders.push({
            file: relative,
            line: index + 1,
            text: line.trim(),
          })
        }
      })
    })

    expect(offenders).toEqual([])
  })
})
