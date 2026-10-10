/**
 * Claude Code sessions: ~/.claude/projects/<folder>/<session id>.jsonl
 *
 * The folder name encodes the working directory lossily (on Windows both
 * `C--Users-…` and `c--Users-…` occur), so the directory is taken from the
 * `cwd` the lines carry instead. Only `user`, `assistant`, `ai-title` and
 * `custom-title` lines are read; every other line type (there are dozens,
 * and new ones appear) is skipped. Verified on 2.1.296.
 */

import type { AgentSessionFile, AgentSessionSource, AgentSessionSummary, SessionFileSystem } from './AgentSessionTypes'
import { joinSessionPath } from './AgentSessionTypes'
import { isRecord, preview, readJsonLineEnds, type JsonRecord } from './jsonLines'

/** Text the user typed: a string, or text blocks (tool results and wrapped commands are not). */
function userText(line: JsonRecord): string | undefined {
  if (line['type'] !== 'user' || line['isMeta'] === true) return undefined
  const message = line['message']
  if (!isRecord(message)) return undefined
  const content = message['content']
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((block): block is JsonRecord => isRecord(block) && block['type'] === 'text')
          .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
          .join('\n')
        : ''
  const trimmed = text.trim()
  // Slash commands and system notes arrive wrapped in <tags>.
  if (trimmed.length === 0 || trimmed.startsWith('<')) return undefined
  return trimmed
}

function assistantText(line: JsonRecord): string | undefined {
  if (line['type'] !== 'assistant') return undefined
  const message = line['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return undefined
  const text = message['content']
    .filter((block): block is JsonRecord => isRecord(block) && block['type'] === 'text')
    .map((block) => (typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n')
    .trim()
  return text.length > 0 ? text : undefined
}

function lastString(lines: JsonRecord[], type: string, key: string): string | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line['type'] === type && typeof line[key] === 'string' && line[key].trim()) return line[key].trim()
  }
  return undefined
}

export const claudeSessions: AgentSessionSource = {
  async listFiles(fs: SessionFileSystem): Promise<AgentSessionFile[]> {
    const home = fs.homeDirectory()
    if (!home) return []
    const root = joinSessionPath(home, '.claude', 'projects')
    const files: AgentSessionFile[] = []
    for (const folder of await fs.listEntries(root)) {
      if (!folder.isDirectory) continue
      const dir = joinSessionPath(root, folder.name)
      for (const entry of await fs.listEntries(dir)) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue
        const path = joinSessionPath(dir, entry.name)
        const stat = await fs.stat(path)
        if (!stat) continue
        files.push({ host: 'claude', id: entry.name.slice(0, -'.jsonl'.length), path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
    return files
  },

  async summarize(fs, file): Promise<AgentSessionSummary | null> {
    const { head, tail } = await readJsonLineEnds(fs, file.path, file.size)
    const all = [...head, ...tail]
    const cwd = all.map((line) => line['cwd']).find((value): value is string => typeof value === 'string' && value.length > 0)
    if (!cwd) return null
    const firstText = head.map(userText).find((text) => text !== undefined)
    let lastText: string | undefined
    for (let index = tail.length - 1; index >= 0 && lastText === undefined; index -= 1) {
      lastText = assistantText(tail[index]) ?? userText(tail[index])
    }
    const title =
      lastString(tail, 'custom-title', 'customTitle') ??
      lastString(head, 'custom-title', 'customTitle') ??
      lastString(tail, 'ai-title', 'aiTitle') ??
      lastString(head, 'ai-title', 'aiTitle') ??
      (firstText ? preview(firstText, 80) : undefined)
    if (!title) return null
    return {
      host: 'claude',
      id: file.id,
      path: file.path,
      cwd,
      title,
      ...(firstText ? { firstText: preview(firstText) } : {}),
      ...(lastText ? { lastText: preview(lastText) } : {}),
      updatedAt: file.mtimeMs,
    }
  },

  resumeArgs: (id) => ['--resume', id],
}
