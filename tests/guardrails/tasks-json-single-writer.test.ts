import fs from 'fs'
import path from 'path'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const ALLOWED_WRITER = path.normalize('features/log/services/LogSnapshotWriter.ts')

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

describe('tasks.json single-writer guardrail', () => {
  test('only LogSnapshotWriter can directly write month snapshot file', () => {
    const offenders: string[] = []
    const files = collectTsFiles(SRC_ROOT)

    for (const filePath of files) {
      const relative = path.relative(SRC_ROOT, filePath)
      if (path.normalize(relative) === ALLOWED_WRITER) {
        continue
      }

      const source = fs.readFileSync(filePath, 'utf8')
      const lines = source.split(/\r?\n/)
      const taskPathVars = new Set<string>()
      const createdWithTaskPath = new Set<string>()
      const modifiedWithTaskFile = new Set<string>()

      for (const line of lines) {
        const taskPathMatch = line.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*.*-tasks\.json/)
        if (taskPathMatch) {
          taskPathVars.add(taskPathMatch[1])
        }
      }

      if (taskPathVars.size === 0) {
        continue
      }

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const createMatch = line.match(/vault\.create\(\s*([A-Za-z_$][\w$]*)\s*,/)
        if (createMatch && taskPathVars.has(createMatch[1])) {
          createdWithTaskPath.add(createMatch[1])
        }

        const modifyMatch = line.match(/vault\.modify\(\s*([A-Za-z_$][\w$]*)\s*,/)
        if (!modifyMatch) {
          continue
        }
        const targetVar = modifyMatch[1]
        if (taskPathVars.has(targetVar)) {
          modifiedWithTaskFile.add(targetVar)
          continue
        }

        // Treat as offense only when this variable is recently derived from
        // getAbstractFileByPath(<taskPathVar>) in nearby lines.
        const lookbackStart = Math.max(0, index - 20)
        for (let i = lookbackStart; i < index; i += 1) {
          const fileRefMatch = lines[i].match(
            /const\s+([A-Za-z_$][\w$]*)\s*=\s*.*getAbstractFileByPath\(\s*([A-Za-z_$][\w$]*)\s*\)/,
          )
          if (!fileRefMatch) {
            continue
          }
          if (fileRefMatch[1] === targetVar && taskPathVars.has(fileRefMatch[2])) {
            modifiedWithTaskFile.add(targetVar)
            break
          }
        }
      }

      if (createdWithTaskPath.size > 0 || modifiedWithTaskFile.size > 0) {
        offenders.push(relative)
      }
    }

    expect(offenders).toEqual([])
  })
})
