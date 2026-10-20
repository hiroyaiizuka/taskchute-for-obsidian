import { AgentSessionHistory } from '@/features/ai-task/sessions/AgentSessionHistory'
import { claudeSessions } from '@/features/ai-task/sessions/claudeSessions'
import { createCodexSessions } from '@/features/ai-task/sessions/codexSessions'
import { cursorSessions } from '@/features/ai-task/sessions/cursorSessions'
import { SessionArchiveStore } from '@/features/ai-task/sessions/SessionArchiveStore'
import { forEachJsonLine, snippetAround } from '@/features/ai-task/sessions/sessionText'
import {
  IndexedDbSessionTextStore,
  MemorySessionTextStore,
  type SessionTextStore,
} from '@/features/ai-task/sessions/SessionTextStore'
import { jsonl, memorySessionFs } from './memorySessionFs'

const HOME = '/home/me'
const VAULT = '/home/me/Vault'
const projects = `${HOME}/.claude/projects/p`

const user = (cwd: string, content: unknown) => ({ type: 'user', cwd, message: { role: 'user', content } })
const assistant = (cwd: string, content: unknown) => ({ type: 'assistant', cwd, message: { role: 'assistant', content } })
const text = (value: string) => [{ type: 'text', text: value }]

/** A session whose middle mentions `middle`; its first and last messages do not. */
function conversation(cwd: string, middle: string) {
  return jsonl(
    user(cwd, 'Plan the move'),
    assistant(cwd, text('Here is a plan.')),
    user(cwd, `What about ${middle}?`),
    assistant(cwd, [{ type: 'tool_use', name: 'Read', input: { file_path: 'secret-tool-input.md' } }]),
    user(cwd, [{ type: 'tool_result', content: 'tool output that mentions needle-in-tool-output' }]),
    assistant(cwd, text(`Noted: ${middle} is handled.`)),
    user(cwd, '<command-name>/clear</command-name>'),
    user(cwd, 'Thanks'),
    assistant(cwd, text('Done.')),
  )
}

function setup(files: Record<string, { content: string; mtimeMs?: number }>, textStore: SessionTextStore = new MemorySessionTextStore()) {
  const memory = memorySessionFs(HOME, files, [VAULT])
  const archive = new SessionArchiveStore({ loadLocalStorage: () => null, saveLocalStorage: () => undefined })
  const history = new AgentSessionHistory(memory.fs, new Map([['claude', claudeSessions]] as const), archive, textStore)
  return { ...memory, history, textStore }
}

const titles = (page: { items: Array<{ title: string }> }) => page.items.map((item) => item.title)

describe('conversation text', () => {
  test("Claude Code: the user's and the agent's words, never tool calls, tool output or wrapped commands", async () => {
    const path = `${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`
    const { fs } = memorySessionFs(HOME, { [path]: { content: conversation(VAULT, 'the parking permit') } })
    const [file] = await claudeSessions.listFiles(fs)
    const extracted = await claudeSessions.conversationText!(fs, file)
    expect(extracted).toBe(
      ['Plan the move', 'Here is a plan.', 'What about the parking permit?', 'Noted: the parking permit is handled.', 'Thanks', 'Done.'].join('\n'),
    )
    expect(extracted).not.toContain('needle-in-tool-output')
    expect(extracted).not.toContain('secret-tool-input')
    expect(extracted).not.toContain('/clear')
  })

  test('Codex: messages of the user and the agent; context the user line wraps in tags is not', async () => {
    const id = '01a11df0-5a7f-7a90-a802-5ac63ec161ae'
    const path = `${HOME}/.codex/sessions/2026/10/09/rollout-2026-10-09T08-54-13-${id}.jsonl`
    const message = (role: string, value: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }] } })
    const { fs } = memorySessionFs(HOME, {
      [path]: {
        content: jsonl(
          { type: 'session_meta', payload: { id, cwd: VAULT } },
          message('user', '<environment_context>cwd</environment_context>'),
          message('user', 'Summarise the README'),
          { type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } },
          message('assistant', 'It is a moving checklist.'),
        ),
      },
    })
    const codex = createCodexSessions()
    const [file] = await codex.listFiles(fs)
    expect(await codex.conversationText!(fs, file)).toBe('Summarise the README\nIt is a moving checklist.')
  })

  test('Cursor: every message of the chat, in order, from store.db', async () => {
    const meta = `${HOME}/.cursor/chats/w/c4a71e00-0000-4000-8000-000000000001/meta.json`
    const store = `${HOME}/.cursor/chats/w/c4a71e00-0000-4000-8000-000000000001/store.db`
    const encoder = new TextEncoder()
    const message = (role: string, content: unknown) => encoder.encode(JSON.stringify({ role, content }))
    const ids = [1, 2, 3, 4].map((n) => n.toString(16).padStart(2, '0').repeat(32))
    const root = new Uint8Array([1, 2, 3, 4].flatMap((n) => [0x0a, 32, ...new Array<number>(32).fill(n)]))
    const hex = (value: string) => Array.from(encoder.encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const { fs } = memorySessionFs(
      HOME,
      { [meta]: { content: JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: VAULT, updatedAtMs: 1 }) } },
      [],
      {
        [store]: {
          meta: { '0': hex(JSON.stringify({ name: 'New Agent', latestRootBlobId: 'root' })) },
          blobs: {
            root,
            [ids[0]]: message('system', 'You are an assistant.'),
            [ids[1]]: message('user', [{ type: 'text', text: '<user_query>\nTranslate the README\n</user_query>' }]),
            [ids[2]]: message('tool', [{ type: 'tool-result', result: 'tool output' }]),
            [ids[3]]: message('assistant', [{ type: 'text', text: 'Translated.' }]),
          },
        },
      },
    )
    const [file] = await cursorSessions.listFiles(fs)
    expect(await cursorSessions.conversationText!(fs, file)).toBe('Translate the README\nTranslated.')
  })

  test('a file read in small chunks: no line and no multibyte character is cut', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ n: i, text: `引っ越しの手続き ${i} `.repeat(i % 7) }))
    const content = jsonl(...lines)
    const path = `${HOME}/big.jsonl`
    const { fs } = memorySessionFs(HOME, { [path]: { content } })
    const size = new TextEncoder().encode(content).length
    const seen: unknown[] = []
    // 37 bytes: far shorter than most lines, and not a multiple of 3.
    await forEachJsonLine(fs, path, size, () => true, (record) => seen.push(record), 37)
    expect(seen).toEqual(lines)
  })

  test('the snippet is the text around the first word found', () => {
    const original = `${'a'.repeat(100)} The Parking Permit is due ${'b'.repeat(200)}`
    const snippet = snippetAround(original, original.toLowerCase(), 'parking')
    expect(snippet).toMatch(/^….*The Parking Permit is due.*…$/u)
    expect(snippetAround(original, original.toLowerCase(), 'absent')).toBeUndefined()
  })
})

describe('full-text search in the history', () => {
  test('finds a word that is only in the middle of the conversation, and shows where', async () => {
    const { history } = setup({
      [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: { mtimeMs: 2, content: conversation(VAULT, 'the parking permit') },
      [`${projects}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`]: { mtimeMs: 1, content: conversation(VAULT, 'the moving boxes') },
    })
    await history.refresh()
    const page = await history.page({ folder: VAULT, query: 'parking permit' })
    expect(titles(page)).toEqual(['Plan the move'])
    expect(page.items[0]?.matchText).toContain('parking permit')
    // Tool output is never searched.
    expect((await history.page({ folder: VAULT, query: 'needle-in-tool-output' })).items).toEqual([])
  })

  test('the words may be split between the title and the conversation', async () => {
    const { history } = setup({
      [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: {
        content: jsonl({ type: 'ai-title', aiTitle: 'Deploy notes' }, user(VAULT, 'Start'), assistant(VAULT, text('The staging server timed out.'))),
      },
    })
    await history.refresh()
    expect(titles(await history.page({ folder: VAULT, query: 'deploy timed' }))).toEqual(['Deploy notes'])
  })

  test('a conversation is extracted once, kept across restarts, and again only when its file changes', async () => {
    const store = new MemorySessionTextStore()
    const files = { [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: { mtimeMs: 1, content: conversation(VAULT, 'the parking permit') } }
    const first = setup(files, store)
    await first.history.refresh()
    await first.history.page({ folder: VAULT, query: 'parking' })
    const readsAfterFirstSearch = first.readRange.mock.calls.length
    await first.history.page({ folder: VAULT, query: 'permit' })
    expect(first.readRange.mock.calls.length).toBe(readsAfterFirstSearch)
    expect(await store.loadAll()).toEqual([expect.objectContaining({ path: `${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`, mtimeMs: 1 })])

    // Obsidian restarted: the kept text is used, the file is only summarised.
    const second = setup(files, store)
    await second.history.refresh()
    await second.history.page({ folder: VAULT, query: 'permit' })
    expect(second.readRange.mock.calls.length).toBe(1)

    // The file changed: extracted again.
    const changed = setup({ [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: { mtimeMs: 2, content: conversation(VAULT, 'the moving boxes') } }, store)
    await changed.history.refresh()
    expect(titles(await changed.history.page({ folder: VAULT, query: 'boxes' }))).toEqual(['Plan the move'])
    expect(titles(await changed.history.page({ folder: VAULT, query: 'permit' }))).toEqual([])
  })

  test('a kept text goes when its session file goes', async () => {
    const { history, remove, textStore } = setup({
      [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: { mtimeMs: 2, content: conversation(VAULT, 'one') },
      [`${projects}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`]: { mtimeMs: 1, content: conversation(VAULT, 'two') },
    })
    await history.refresh()
    await history.prepareSearch(VAULT)
    expect((await textStore.loadAll()).map((entry) => entry.path).sort()).toEqual([`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`, `${projects}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`])
    remove(`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`)
    await history.refresh()
    expect((await textStore.loadAll()).map((entry) => entry.path)).toEqual([`${projects}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`])
  })

  test("preparing search extracts only the folder's sessions", async () => {
    const { history, textStore } = setup({
      [`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`]: { content: conversation(VAULT, 'here') },
      [`${projects}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl`]: { content: conversation('/home/me/Elsewhere', 'there') },
    })
    await history.refresh()
    await history.prepareSearch(VAULT)
    expect((await textStore.loadAll()).map((entry) => entry.path)).toEqual([`${projects}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`])
  })

  test('without IndexedDB the texts are kept in memory for the run', async () => {
    const store = new IndexedDbSessionTextStore(undefined)
    await store.put({ path: '/x', size: 1, mtimeMs: 1, text: 'hello' })
    expect(await store.loadAll()).toEqual([{ path: '/x', size: 1, mtimeMs: 1, text: 'hello' }])
    await store.remove(['/x'])
    expect(await store.loadAll()).toEqual([])
  })
})
