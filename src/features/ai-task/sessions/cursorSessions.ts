/**
 * Cursor sessions: ~/.cursor/chats/<workspace hash>/<chat id>/
 *
 * - meta.json (`schemaVersion` 1): the folder and the times.
 * - store.db (SQLite): the conversation.
 *   - table `meta`, one row: hex-encoded JSON with `name` (the chat's title;
 *     "New Agent" until Cursor names it) and `latestRootBlobId`.
 *   - table `blobs`: the root blob is a protobuf message whose field 1 repeats
 *     the 32-byte ids of the message blobs, in order; a message blob is JSON,
 *     `{ role, content }`, where a user's own words sit inside
 *     `<user_query>…</user_query>`.
 *
 * None of this is a published format, so every step falls back: a store that
 * cannot be read leaves the session named after its folder, with no messages.
 * Verified on 2026.10.01.
 */

import type { AgentSessionFile, AgentSessionSource, AgentSessionSummary, SessionFileSystem } from './AgentSessionTypes'
import { joinSessionPath } from './AgentSessionTypes'
import { isRecord, preview, readSmallText } from './jsonLines'
import { joinMessages } from './sessionText'

const META_MAX_BYTES = 64 * 1024
/** Message blobs read from each end of a conversation to find the first prompt and the last reply. */
const MESSAGES_PER_END = 12
const MESSAGE_ID_BYTES = 32
/** The title Cursor gives a chat before it names it. */
const UNNAMED_CHAT = 'New Agent'
const META_TABLE = { name: 'meta', key: 'key', value: 'value' }
const BLOBS_TABLE = { name: 'blobs', key: 'id', value: 'data' }

function folderName(cwd: string): string {
  return cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || cwd
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function parseJson(value: string | Uint8Array | undefined): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(typeof value === 'string' ? value : new TextDecoder('utf-8').decode(value))
  } catch {
    return undefined
  }
}

/** The ids of the message blobs, in order: field 1 of the root protobuf message. */
export function messageIdsOfRoot(root: Uint8Array): string[] {
  const ids: string[] = []
  let offset = 0
  const readVarint = (): number | null => {
    let value = 0
    for (let shift = 0; offset < root.length && shift < 35; shift += 7) {
      const byte = root[offset] ?? 0
      offset += 1
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    return null
  }
  while (offset < root.length) {
    const tag = readVarint()
    if (tag === null) break
    const field = Math.floor(tag / 8)
    const wireType = tag % 8
    if (wireType === 0) {
      if (readVarint() === null) break
    } else if (wireType === 2) {
      const length = readVarint()
      if (length === null || offset + length > root.length) break
      if (field === 1 && length === MESSAGE_ID_BYTES) ids.push(toHex(root.subarray(offset, offset + length)))
      offset += length
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else {
      break
    }
  }
  return ids
}

/** The text parts of a message's content (a string, or parts with `type: "text"`). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''))
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

/** What the user typed: Cursor wraps it, and sends its own context as user messages too. */
function userQuery(text: string): string | undefined {
  const match = /<user_query>([\s\S]*?)<\/user_query>/u.exec(text)
  const query = match?.[1]?.trim()
  return query && query.length > 0 ? query : undefined
}

interface Conversation {
  name?: string
  firstText?: string
  lastText?: string
}

/** The chat's name (unless Cursor has not named it yet) and its message ids, in order. */
async function readChat(fs: SessionFileSystem, storePath: string): Promise<{ name?: string; ids: string[] } | null> {
  if (!fs.readSqliteTable) return null
  const metaRows = await fs.readSqliteTable(storePath, META_TABLE)
  const metaHex = metaRows ? Array.from(metaRows.values())[0] : undefined
  const metaBytes = typeof metaHex === 'string' ? fromHex(metaHex) : null
  const meta = metaBytes ? parseJson(metaBytes) : undefined
  if (!isRecord(meta)) return null
  const name = typeof meta['name'] === 'string' && meta['name'].trim() !== '' ? meta['name'].trim() : undefined
  const chat = { ...(name && name !== UNNAMED_CHAT ? { name } : {}), ids: [] as string[] }
  const rootId = meta['latestRootBlobId']
  if (typeof rootId !== 'string') return chat
  const root = (await fs.readSqliteTable(storePath, BLOBS_TABLE, [rootId]))?.get(rootId)
  if (root instanceof Uint8Array) chat.ids = messageIdsOfRoot(root)
  return chat
}

/** The messages with these ids, in the order given. */
async function readMessages(fs: SessionFileSystem, storePath: string, ids: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const blobs = fs.readSqliteTable ? await fs.readSqliteTable(storePath, BLOBS_TABLE, ids) : null
  if (!blobs) return []
  return ids.map((id) => parseJson(blobs.get(id))).filter(isRecord)
}

/** The words of one message: what the user typed, or the agent's reply; nothing else. */
function wordsOf(message: Record<string, unknown>): string | undefined {
  if (message['role'] === 'user') return userQuery(textOf(message['content']))
  if (message['role'] !== 'assistant') return undefined
  const text = textOf(message['content']).trim()
  return text.length > 0 ? text : undefined
}

async function readConversation(fs: SessionFileSystem, storePath: string): Promise<Conversation> {
  const chat = await readChat(fs, storePath)
  if (!chat) return {}
  const conversation: Conversation = chat.name ? { name: chat.name } : {}
  const ids = chat.ids
  const wanted = Array.from(new Set([...ids.slice(0, MESSAGES_PER_END), ...ids.slice(-MESSAGES_PER_END)]))
  const messages = await readMessages(fs, storePath, wanted)
  const first = messages.find((message) => message['role'] === 'user' && wordsOf(message))
  if (first) conversation.firstText = wordsOf(first)
  const last = [...messages].reverse().find((message) => wordsOf(message))
  if (last) conversation.lastText = wordsOf(last)
  return conversation
}

function storePathOf(file: AgentSessionFile): string {
  return `${file.path.slice(0, -'meta.json'.length)}store.db`
}

export const cursorSessions: AgentSessionSource = {
  async listFiles(fs): Promise<AgentSessionFile[]> {
    const home = fs.homeDirectory()
    if (!home) return []
    const root = joinSessionPath(home, '.cursor', 'chats')
    const files: AgentSessionFile[] = []
    for (const workspace of await fs.listEntries(root)) {
      if (!workspace.isDirectory) continue
      const workspaceDir = joinSessionPath(root, workspace.name)
      for (const chat of await fs.listEntries(workspaceDir)) {
        if (!chat.isDirectory) continue
        const path = joinSessionPath(workspaceDir, chat.name, 'meta.json')
        const stat = await fs.stat(path)
        if (stat) files.push({ host: 'cursor', id: chat.name, path, size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
    return files
  },

  async summarize(fs, file): Promise<AgentSessionSummary | null> {
    const text = await readSmallText(fs, file.path, META_MAX_BYTES)
    if (text === null) return null
    let meta: unknown
    try {
      meta = JSON.parse(text)
    } catch {
      return null
    }
    if (!isRecord(meta) || meta['schemaVersion'] !== 1 || meta['hasConversation'] === false) return null
    const cwd = typeof meta['cwd'] === 'string' ? meta['cwd'] : undefined
    if (!cwd) return null
    const updatedAt = typeof meta['updatedAtMs'] === 'number' ? meta['updatedAtMs'] : file.mtimeMs
    const { name, firstText, lastText } = await readConversation(fs, storePathOf(file))
    return {
      host: 'cursor',
      id: file.id,
      path: file.path,
      cwd,
      title: name ?? (firstText ? preview(firstText, 80) : folderName(cwd)),
      ...(firstText ? { firstText: preview(firstText) } : {}),
      ...(lastText ? { lastText: preview(lastText) } : {}),
      updatedAt,
    }
  },

  async conversationText(fs, file): Promise<string | null> {
    const chat = await readChat(fs, storePathOf(file))
    if (!chat) return null
    const messages = await readMessages(fs, storePathOf(file), chat.ids)
    return joinMessages(messages.map(wordsOf).filter((text): text is string => text !== undefined))
  },

  resumeArgs: (id) => ['--resume', id],
}
