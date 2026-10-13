import { claudeSessions } from '@/features/ai-task/sessions/claudeSessions'
import { createCodexSessions } from '@/features/ai-task/sessions/codexSessions'
import { cursorSessions } from '@/features/ai-task/sessions/cursorSessions'
import { HEAD_BYTES, TAIL_BYTES } from '@/features/ai-task/sessions/jsonLines'
import { searchWords, matchesAllWords } from '@/features/ai-task/sessions/sessionSearch'
import { jsonl, memorySessionFs } from './memorySessionFs'

const HOME = '/home/me'
const VAULT = '/home/me/Vault'

async function readOne(source: typeof claudeSessions, fs: ReturnType<typeof memorySessionFs>['fs']) {
  const [file] = await source.listFiles(fs)
  return file ? source.summarize(fs, file) : null
}

describe('Claude Code sessions', () => {
  const path = `${HOME}/.claude/projects/-home-me-Vault/11111111-aaaa.jsonl`

  test('title, folder, first and last message; commands, tool results and unknown lines are skipped', async () => {
    const { fs } = memorySessionFs(HOME, {
      [path]: {
        mtimeMs: 5,
        content: jsonl(
          { type: 'permission-mode', permissionMode: 'auto' },
          { type: 'user', cwd: VAULT, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
          { type: 'user', cwd: VAULT, isMeta: true, message: { role: 'user', content: 'meta note' } },
          { type: 'user', cwd: VAULT, message: { role: 'user', content: 'Plan the move' } },
          { type: 'user', cwd: VAULT, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
          { type: 'ai-title', aiTitle: 'Moving plan' },
          { type: 'something-new', anything: true },
          { type: 'assistant', cwd: VAULT, message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan.' }] } },
        ),
      },
    })

    expect(await readOne(claudeSessions, fs)).toEqual({
      host: 'claude',
      id: '11111111-aaaa',
      path,
      cwd: VAULT,
      title: 'Moving plan',
      firstText: 'Plan the move',
      lastText: 'Here is the plan.',
      updatedAt: 5,
    })
    expect(claudeSessions.resumeArgs('11111111-aaaa')).toEqual(['--resume', '11111111-aaaa'])
  })

  test('a name the user gave wins over the generated title; the first prompt is the last resort', async () => {
    const named = memorySessionFs(HOME, {
      [path]: { content: jsonl({ type: 'user', cwd: VAULT, message: { content: 'hi' } }, { type: 'ai-title', aiTitle: 'Greeting' }, { type: 'custom-title', customTitle: 'My session' }) },
    })
    expect((await readOne(claudeSessions, named.fs))?.title).toBe('My session')
    const plain = memorySessionFs(HOME, { [path]: { content: jsonl({ type: 'user', cwd: VAULT, message: { content: 'just this' } }) } })
    expect((await readOne(claudeSessions, plain.fs))?.title).toBe('just this')
  })

  test('a large file is read only at its two ends', async () => {
    const filler = { type: 'assistant', cwd: VAULT, message: { content: [{ type: 'text', text: 'x'.repeat(1000) }] } }
    const middle = Array.from({ length: 500 }, () => filler)
    const content = jsonl(
      { type: 'user', cwd: VAULT, message: { content: 'first question' } },
      ...middle,
      { type: 'custom-title', customTitle: 'Late name' },
      { type: 'assistant', cwd: VAULT, message: { content: [{ type: 'text', text: 'final answer' }] } },
    )
    expect(content.length).toBeGreaterThan(HEAD_BYTES + TAIL_BYTES)
    const { fs, readRange } = memorySessionFs(HOME, { [path]: { content } })

    const summary = await readOne(claudeSessions, fs)

    expect(summary).toEqual(expect.objectContaining({ title: 'Late name', firstText: 'first question', lastText: 'final answer' }))
    const readBytes = readRange.mock.calls.reduce((sum, call) => sum + call[2], 0)
    expect(readBytes).toBe(HEAD_BYTES + TAIL_BYTES)
  })

  test('a file without a working folder is not a session the list can show', async () => {
    const { fs } = memorySessionFs(HOME, { [path]: { content: jsonl({ type: 'summary', summary: 'x' }) } })
    expect(await readOne(claudeSessions, fs)).toBeNull()
  })
})

describe('Codex sessions', () => {
  const id = '01a11df0-5a7f-7a90-a802-5ac63ec161ae'
  const path = `${HOME}/.codex/sessions/2026/10/09/rollout-2026-10-09T08-54-13-${id}.jsonl`

  test('folder from the session meta, the latest thread name as title, context lines skipped', async () => {
    const { fs } = memorySessionFs(HOME, {
      [`${HOME}/.codex/session_index.jsonl`]: {
        content: jsonl({ id, thread_name: 'first name' }, { id, thread_name: 'Summarize README' }),
      },
      [path]: {
        mtimeMs: 9,
        content: jsonl(
          { type: 'session_meta', payload: { id, cwd: VAULT, cli_version: '0.150.1' } },
          { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read README.md' }] } },
          { type: 'event_msg', payload: { type: 'token_count' } },
          { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
        ),
      },
    })
    const codex = createCodexSessions()

    expect(await readOne(codex, fs)).toEqual({
      host: 'codex', id, path, cwd: VAULT, title: 'Summarize README', firstText: 'Read README.md', lastText: 'Done.', updatedAt: 9,
    })
    expect(codex.resumeArgs(id)).toEqual(['resume', id])
  })
})

describe('Cursor sessions', () => {
  const path = `${HOME}/.cursor/chats/abc/chat-1/meta.json`
  const store = `${HOME}/.cursor/chats/abc/chat-1/store.db`
  const metaJson = JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: VAULT, updatedAtMs: 42 })
  const encoder = new TextEncoder()
  const hex = (text: string) => Array.from(encoder.encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const idOf = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
  const idBytes = (n: number) => new Uint8Array(32).fill(n)
  /** The root blob as Cursor writes it: field 1 repeats the message ids; other fields follow. */
  const rootOf = (count: number) => {
    const bytes: number[] = []
    for (let n = 1; n <= count; n += 1) bytes.push(0x0a, 32, ...idBytes(n))
    bytes.push(0x4a, 3, 0x61, 0x62, 0x63, 0x50, 1)
    return new Uint8Array(bytes)
  }
  const message = (role: string, content: unknown) => encoder.encode(JSON.stringify({ role, content }))
  const query = (text: string) => [{ type: 'text', text: `<timestamp>now</timestamp>\n<user_query>\n${text}\n</user_query>` }]
  const storeOf = (name: string, messages: Uint8Array[]) => ({
    meta: { '0': hex(JSON.stringify({ name, latestRootBlobId: 'root' })) },
    blobs: Object.fromEntries([['root', rootOf(messages.length)], ...messages.map((data, index) => [idOf(index + 1), data] as const)]),
  })
  const conversation = [
    message('system', 'You are an AI coding assistant.'),
    message('user', '<user_info>\nOS Version: linux\n</user_info>'),
    message('user', query('README を英語に訳して')),
    message('assistant', [{ type: 'reasoning', text: '' }, { type: 'text', text: '確認します。' }, { type: 'tool-call' }]),
    message('tool', [{ type: 'tool-result', result: '# メモ' }]),
    message('assistant', [{ type: 'reasoning', text: '' }, { type: 'text', text: '英語に訳しました。' }]),
  ]

  test('the chat name, the first prompt and the last reply come from store.db', async () => {
    const { fs } = memorySessionFs(HOME, { [path]: { content: metaJson } }, [], { [store]: storeOf('README の英訳', conversation) })
    expect(await readOne(cursorSessions, fs)).toEqual({
      host: 'cursor',
      id: 'chat-1',
      path,
      cwd: VAULT,
      title: 'README の英訳',
      firstText: 'README を英語に訳して',
      lastText: '英語に訳しました。',
      updatedAt: 42,
    })
    expect(cursorSessions.resumeArgs('chat-1')).toEqual(['--resume', 'chat-1'])
  })

  test('a chat Cursor has not named yet is titled by its first prompt', async () => {
    const { fs } = memorySessionFs(HOME, { [path]: { content: metaJson } }, [], { [store]: storeOf('New Agent', conversation) })
    expect(await readOne(cursorSessions, fs)).toEqual(expect.objectContaining({ title: 'README を英語に訳して', lastText: '英語に訳しました。' }))
  })

  test('a long conversation is read from both ends only', async () => {
    const middle = Array.from({ length: 60 }, (_, index) => message('assistant', [{ type: 'text', text: `step ${index}` }]))
    const long = [...conversation.slice(0, 3), ...middle, message('user', query('ありがとう')), message('assistant', [{ type: 'text', text: 'どういたしまして。' }])]
    const sqlite = { [store]: storeOf('New Agent', long) }
    const { fs } = memorySessionFs(HOME, { [path]: { content: metaJson } }, [], sqlite)
    const read = jest.spyOn(fs, 'readSqliteTable')
    expect(await readOne(cursorSessions, fs)).toEqual(expect.objectContaining({ firstText: 'README を英語に訳して', lastText: 'どういたしまして。' }))
    const requested = read.mock.calls.map(([, , keys]) => keys?.length ?? 0)
    expect(Math.max(...requested)).toBeLessThanOrEqual(24)
  })

  test('without a readable store the session is named after its folder, with no messages', async () => {
    const meta = { [path]: { content: metaJson } }
    const expected = { host: 'cursor', id: 'chat-1', path, cwd: VAULT, title: 'Vault', updatedAt: 42 }
    // No store.db, a store in a format this plugin does not know, and a runtime with no SQLite reader.
    expect(await readOne(cursorSessions, memorySessionFs(HOME, meta).fs)).toEqual(expected)
    expect(await readOne(cursorSessions, memorySessionFs(HOME, meta, [], { [store]: { meta: { '0': 'not hex' }, blobs: {} } }).fs)).toEqual(expected)
    const { fs } = memorySessionFs(HOME, meta, [], { [store]: storeOf('README の英訳', conversation) })
    delete fs.readSqliteTable
    expect(await readOne(cursorSessions, fs)).toEqual(expected)
  })

  test('an unknown schema or an empty chat is skipped', async () => {
    for (const meta of [{ schemaVersion: 2, cwd: VAULT }, { schemaVersion: 1, hasConversation: false, cwd: VAULT }, 'not json']) {
      const { fs } = memorySessionFs(HOME, { [path]: { content: typeof meta === 'string' ? meta : JSON.stringify(meta) } })
      expect(await readOne(cursorSessions, fs)).toBeNull()
    }
  })
})

describe('search words', () => {
  test('a Japanese query is split into words; particles are not required', () => {
    // How finely a word is split is up to the browser (タイムアウト may come out
    // as タイム + アウト); what matters is which texts match.
    const words = searchWords('ログインのタイムアウト')
    expect(words).toContain('ログイン')
    expect(words).not.toContain('の')
    expect(matchesAllWords('タイムアウトしたログインを直す', words)).toBe(true)
    expect(matchesAllWords('ログインを直す', words)).toBe(false)
  })

  test('words in any order, case-blind; an empty query matches everything', () => {
    const words = searchWords('Deploy staging')
    expect(matchesAllWords('Staging DEPLOY failed', words)).toBe(true)
    expect(matchesAllWords('anything', searchWords('  '))).toBe(true)
  })
})
