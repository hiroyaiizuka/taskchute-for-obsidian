/**
 * Codex sessions: ~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl
 *
 * The folder is the `cwd` of the `session_meta` line; the title is the latest
 * `thread_name` for the id in ~/.codex/session_index.jsonl. Messages are the
 * `response_item` lines of role user / assistant; the user's lines that wrap
 * context in <tags> are skipped. Codex is moving sessions to a new history
 * format (`codex migrate-rollouts`), so anything unrecognised is skipped
 * rather than guessed at. Verified on 0.150.1.
 */

import type { AgentSessionFile, AgentSessionSource, AgentSessionSummary, SessionFileSystem } from './AgentSessionTypes'
import { joinSessionPath } from './AgentSessionTypes'
import { isRecord, preview, readJsonLineEnds, readSmallText, type JsonRecord } from './jsonLines'

const ROLLOUT_ID = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u
const INDEX_MAX_BYTES = 8 * 1024 * 1024

function messageText(line: JsonRecord, role: 'user' | 'assistant'): string | undefined {
  if (line['type'] !== 'response_item') return undefined
  const payload = line['payload']
  if (!isRecord(payload) || payload['type'] !== 'message' || payload['role'] !== role) return undefined
  if (!Array.isArray(payload['content'])) return undefined
  const text = payload['content']
    .filter((block): block is JsonRecord => isRecord(block) && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n')
    .trim()
  if (text.length === 0 || (role === 'user' && text.startsWith('<'))) return undefined
  return text
}

async function readThreadNames(fs: SessionFileSystem, home: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const text = await readSmallText(fs, joinSessionPath(home, '.codex', 'session_index.jsonl'), INDEX_MAX_BYTES)
  for (const line of text?.split('\n') ?? []) {
    try {
      const entry: unknown = JSON.parse(line)
      if (isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['thread_name'] === 'string') {
        names.set(entry['id'], entry['thread_name'])
      }
    } catch {
      // Not a line this plugin knows: skip it.
    }
  }
  return names
}

async function listDirectories(fs: SessionFileSystem, path: string): Promise<string[]> {
  return (await fs.listEntries(path)).filter((entry) => entry.isDirectory).map((entry) => joinSessionPath(path, entry.name))
}

/** A reader with its own title list, refreshed each time the files are listed. */
export function createCodexSessions(): AgentSessionSource {
  let threadNames = new Map<string, string>()
  return {
  async listFiles(fs): Promise<AgentSessionFile[]> {
    const home = fs.homeDirectory()
    if (!home) return []
    threadNames = await readThreadNames(fs, home)
    const files: AgentSessionFile[] = []
    for (const year of await listDirectories(fs, joinSessionPath(home, '.codex', 'sessions'))) {
      for (const month of await listDirectories(fs, year)) {
        for (const day of await listDirectories(fs, month)) {
          for (const entry of await fs.listEntries(day)) {
            const match = entry.isFile ? ROLLOUT_ID.exec(entry.name) : null
            if (!match) continue
            const path = joinSessionPath(day, entry.name)
            const stat = await fs.stat(path)
            if (stat) files.push({ host: 'codex', id: match[1], path, size: stat.size, mtimeMs: stat.mtimeMs })
          }
        }
      }
    }
    return files
  },

  async summarize(fs, file): Promise<AgentSessionSummary | null> {
    const { head, tail } = await readJsonLineEnds(fs, file.path, file.size)
    const meta = head.find((line) => line['type'] === 'session_meta')
    const payload = meta && isRecord(meta['payload']) ? meta['payload'] : undefined
    const cwd = typeof payload?.['cwd'] === 'string' ? payload['cwd'] : undefined
    if (!cwd) return null
    const firstText = head.map((line) => messageText(line, 'user')).find((text) => text !== undefined)
    let lastText: string | undefined
    for (let index = tail.length - 1; index >= 0 && lastText === undefined; index -= 1) {
      lastText = messageText(tail[index], 'assistant') ?? messageText(tail[index], 'user')
    }
    const title = threadNames.get(file.id)?.trim() || (firstText ? preview(firstText, 80) : undefined)
    if (!title) return null
    return {
      host: 'codex',
      id: file.id,
      path: file.path,
      cwd,
      title,
      ...(firstText ? { firstText: preview(firstText) } : {}),
      ...(lastText ? { lastText: preview(lastText) } : {}),
      updatedAt: file.mtimeMs,
    }
  },

  resumeArgs: (id) => ['resume', id],
  }
}
