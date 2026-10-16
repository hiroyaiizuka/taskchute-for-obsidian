import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { NodeProcessGateway } from '@/features/ai-task/services/NodeProcessGateway'
import type { SessionFileSystem } from '@/features/ai-task/sessions/AgentSessionTypes'
import { cursorSessions } from '@/features/ai-task/sessions/cursorSessions'

// The Cursor reader against a real SQLite file, through the real gateway:
// the shape of store.db as Cursor 2026.10.01 writes it.

interface Database {
  exec(sql: string): void
  prepare(sql: string): { run(...params: Array<string | Uint8Array>): unknown }
  close(): void
}
// node:sqlite has no types in this project.
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => Database }

const encoder = new TextEncoder()
const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')

describe('Cursor store.db (real SQLite)', () => {
  let home: string
  let chatDir: string
  let writer: Database | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-cursor-store-'))
    chatDir = path.join(home, '.cursor', 'chats', 'workspace', 'chat-1')
    fs.mkdirSync(chatDir, { recursive: true })
    fs.writeFileSync(
      path.join(chatDir, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: '/work/project', updatedAtMs: 42 }),
    )
  })

  afterEach(() => {
    writer?.close()
    writer = undefined
    fs.rmSync(home, { recursive: true, force: true })
  })

  function writeStore(journalMode: 'delete' | 'wal'): void {
    writer = new DatabaseSync(path.join(chatDir, 'store.db'))
    writer.exec(`PRAGMA journal_mode = ${journalMode}`)
    writer.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    const messages = [
      { role: 'system', content: 'You are an AI coding assistant.' },
      { role: 'user', content: [{ type: 'text', text: '<user_query>\nREADME を英語に訳して\n</user_query>' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: '英語に訳しました。' }] },
    ]
    const insert = writer.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
    const root: number[] = []
    messages.forEach((message, index) => {
      const id = new Uint8Array(32).fill(index + 1)
      insert.run(Buffer.from(id).toString('hex'), encoder.encode(JSON.stringify(message)))
      root.push(0x0a, 32, ...id)
    })
    insert.run('root', new Uint8Array(root))
    writer
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('0', hex(JSON.stringify({ name: 'New Agent', latestRootBlobId: 'root' })))
  }

  function sessionFs(): SessionFileSystem {
    const gateway = new NodeProcessGateway()
    return {
      homeDirectory: () => home,
      listEntries: (target) => gateway.listEntries(target),
      stat: (target) => gateway.statPath(target),
      readRange: (target, position, length) => gateway.readFileRange(target, position, length),
      readSqliteTable: (target, table, keys) => gateway.readSqliteTable(target, table, keys),
    }
  }

  async function readChat() {
    const files = sessionFs()
    const [file] = await cursorSessions.listFiles(files)
    return file ? cursorSessions.summarize(files, file) : null
  }

  const expected = expect.objectContaining({
    host: 'cursor',
    id: 'chat-1',
    cwd: '/work/project',
    title: 'README を英語に訳して',
    firstText: 'README を英語に訳して',
    lastText: '英語に訳しました。',
  })

  test('reads the first prompt and the last reply', async () => {
    writeStore('delete')
    writer?.close()
    writer = undefined
    expect(await readChat()).toEqual(expected)
  })

  test('reads a store whose latest writes are still in the write-ahead log (Cursor running)', async () => {
    writeStore('wal')
    expect(fs.statSync(path.join(chatDir, 'store.db-wal')).size).toBeGreaterThan(0)
    expect(await readChat()).toEqual(expected)
  })

  test('a file that is not a database leaves the session named after its folder', async () => {
    fs.writeFileSync(path.join(chatDir, 'store.db'), 'not a database')
    expect(await readChat()).toEqual({
      host: 'cursor',
      id: 'chat-1',
      path: path.join(chatDir, 'meta.json'),
      cwd: '/work/project',
      title: 'project',
      updatedAt: 42,
    })
  })

  test('the store is not changed by reading it', async () => {
    writeStore('delete')
    writer?.close()
    writer = undefined
    const before = fs.readFileSync(path.join(chatDir, 'store.db'))
    await readChat()
    expect(fs.readFileSync(path.join(chatDir, 'store.db')).equals(before)).toBe(true)
    expect(fs.readdirSync(chatDir).sort()).toEqual(['meta.json', 'store.db'])
  })
})
