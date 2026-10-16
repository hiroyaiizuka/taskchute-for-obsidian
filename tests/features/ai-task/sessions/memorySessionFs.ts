import type { SessionFileSystem } from '@/features/ai-task/sessions/AgentSessionTypes'

/** An in-memory, read-only file tree with a home folder, for the session readers. */
/** A SQLite file as the readers see it: its tables, each a key → value map. */
export type MemorySqliteFile = Record<string, Record<string, string | Uint8Array>>

export function memorySessionFs(
  home: string,
  files: Record<string, { content: string; mtimeMs?: number }>,
  folders: string[] = [],
  sqlite: Record<string, MemorySqliteFile> = {},
) {
  const encoder = new TextEncoder()
  const bytes = new Map(Object.entries(files).map(([path, file]) => [path, { data: encoder.encode(file.content), mtimeMs: file.mtimeMs ?? 0 }]))
  const isFolder = (path: string) =>
    folders.includes(path) || Array.from(bytes.keys()).some((file) => file.startsWith(`${path}/`))
  const readRange = jest.fn(async (path: string, position: number, length: number) => {
    const file = bytes.get(path)
    if (!file) throw new Error(`missing ${path}`)
    return new TextDecoder().decode(file.data.subarray(position, position + length))
  })
  const fs: SessionFileSystem = {
    homeDirectory: () => home,
    listEntries: async (path) => {
      const names = new Map<string, boolean>()
      for (const file of [...bytes.keys(), ...folders.map((folder) => `${folder}/`)]) {
        if (!file.startsWith(`${path}/`)) continue
        const rest = file.slice(path.length + 1)
        const [name, ...more] = rest.split('/')
        if (!name) continue
        names.set(name, (names.get(name) ?? false) || more.length > 0)
      }
      return Array.from(names, ([name, hasChildren]) => ({
        name,
        isDirectory: hasChildren || isFolder(`${path}/${name}`),
        isFile: !hasChildren && bytes.has(`${path}/${name}`),
      }))
    },
    stat: async (path) => {
      const file = bytes.get(path)
      if (file) return { size: file.data.length, mtimeMs: file.mtimeMs, isDirectory: false }
      return isFolder(path) ? { size: 0, mtimeMs: 0, isDirectory: true } : null
    },
    readRange,
    readSqliteTable: async (path, table, keys) => {
      const rows = sqlite[path]?.[table.name]
      if (!rows) return null
      return new Map(Object.entries(rows).filter(([key]) => !keys || keys.includes(key)))
    },
  }
  return { fs, readRange, remove: (path: string) => bytes.delete(path) }
}

export const jsonl = (...lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
