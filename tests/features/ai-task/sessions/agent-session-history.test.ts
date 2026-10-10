import { AgentSessionHistory, isInsideFolder } from '@/features/ai-task/sessions/AgentSessionHistory'
import { claudeSessions } from '@/features/ai-task/sessions/claudeSessions'
import { cursorSessions } from '@/features/ai-task/sessions/cursorSessions'
import { AI_SESSION_ARCHIVE_STORAGE_KEY, SessionArchiveStore } from '@/features/ai-task/sessions/SessionArchiveStore'
import { jsonl, memorySessionFs } from './memorySessionFs'

const HOME = '/home/me'
const VAULT = '/home/me/Vault'
const projects = `${HOME}/.claude/projects/p`

function claudeFile(id: string, cwd: string, title: string, mtimeMs: number, extra = '') {
  return {
    [`${projects}/${id}.jsonl`]: {
      mtimeMs,
      content: jsonl(
        { type: 'user', cwd, message: { content: `ask about ${title} ${extra}`.trim() } },
        { type: 'ai-title', aiTitle: title },
      ),
    },
  }
}

function setup(files: Record<string, { content: string; mtimeMs?: number }>, folders: string[] = [VAULT, `${VAULT}/sub`]) {
  const memory = memorySessionFs(HOME, files, folders)
  let stored: unknown = null
  const storage = { loadLocalStorage: jest.fn(() => stored), saveLocalStorage: jest.fn((_key: string, value: unknown) => { stored = value }) }
  const history = new AgentSessionHistory(
    memory.fs,
    new Map([['claude', claudeSessions], ['cursor', cursorSessions]] as const),
    new SessionArchiveStore(storage),
  )
  return { ...memory, history, storage, stored: () => stored }
}

const titles = (page: { items: Array<{ title: string }> }) => page.items.map((item) => item.title)

describe('AgentSessionHistory', () => {
  test("lists only the vault folder's sessions (and its subfolders), newest first", async () => {
    const { history } = setup({
      ...claudeFile('a', VAULT, 'Older', 1),
      ...claudeFile('b', `${VAULT}/sub`, 'In a subfolder', 3),
      ...claudeFile('c', '/home/me/OtherProject', 'Elsewhere', 4),
      ...claudeFile('d', `${VAULT}-copy`, 'Look-alike folder', 5),
      ...claudeFile('e', VAULT, 'Newest', 6),
    })
    await history.refresh()
    expect(titles(await history.page({ folder: VAULT }))).toEqual(['Newest', 'In a subfolder', 'Older'])
  })

  test('a session whose folder is gone is not listed', async () => {
    const { history } = setup({ ...claudeFile('a', `${VAULT}/deleted`, 'Gone folder', 2), ...claudeFile('b', VAULT, 'Here', 1) })
    await history.refresh()
    expect(titles(await history.page({ folder: VAULT }))).toEqual(['Here'])
  })

  test('Windows folders compare without case and with either slash', () => {
    expect(isInsideFolder('c:\\Users\\Me\\Vault\\notes', 'C:/Users/me/vault')).toBe(true)
    expect(isInsideFolder('C:\\Users\\Me\\VaultCopy', 'C:\\Users\\Me\\Vault')).toBe(false)
    expect(isInsideFolder('/home/Me/vault', '/home/me/vault')).toBe(false)
  })

  test('search matches every word in the title or the first and last messages', async () => {
    const { history } = setup({
      ...claudeFile('a', VAULT, 'ログインの修正', 2, 'タイムアウトが起きる'),
      ...claudeFile('b', VAULT, 'デプロイ', 1),
    })
    await history.refresh()
    expect(titles(await history.page({ folder: VAULT, query: 'タイムアウト ログイン' }))).toEqual(['ログインの修正'])
    expect(titles(await history.page({ folder: VAULT, query: 'nothing like it' }))).toEqual([])
  })

  test('pages continue from where the last stopped', async () => {
    const files = Object.assign({}, ...Array.from({ length: 5 }, (_, i) => claudeFile(`s${i}`, VAULT, `Session ${i}`, i)))
    const { history } = setup(files)
    await history.refresh()
    const first = await history.page({ folder: VAULT, limit: 2 })
    expect(titles(first)).toEqual(['Session 4', 'Session 3'])
    const second = await history.page({ folder: VAULT, limit: 2, cursor: first.nextCursor ?? undefined })
    expect(titles(second)).toEqual(['Session 2', 'Session 1'])
    const third = await history.page({ folder: VAULT, limit: 2, cursor: second.nextCursor ?? undefined })
    expect(titles(third)).toEqual(['Session 0'])
    expect(third.nextCursor).toBeNull()
  })

  test('archiving hides a session; the archived view shows it and it can be restored', async () => {
    const { history, stored } = setup({ ...claudeFile('a', VAULT, 'Keep', 2), ...claudeFile('b', VAULT, 'Hide', 1) })
    await history.refresh()
    history.archiveSession('claude', 'b')

    expect(titles(await history.page({ folder: VAULT }))).toEqual(['Keep'])
    expect(await history.page({ folder: VAULT, archived: true })).toEqual({
      items: [expect.objectContaining({ title: 'Hide', archived: true })],
      nextCursor: null,
    })
    expect(stored()).toEqual({ version: 1, items: { 'claude:b': expect.any(Number) } })

    history.restoreSession('claude', 'b')
    expect(titles(await history.page({ folder: VAULT }))).toEqual(['Keep', 'Hide'])
  })

  test("the archive forgets sessions whose files are gone, so it never outgrows what exists", async () => {
    const { history, remove, stored } = setup({ ...claudeFile('a', VAULT, 'A', 2), ...claudeFile('b', VAULT, 'B', 1) })
    await history.refresh()
    history.archiveSession('claude', 'a')
    history.archiveSession('claude', 'b')
    remove(`${projects}/a.jsonl`)
    await history.refresh()
    expect(stored()).toEqual({ version: 1, items: { 'claude:b': expect.any(Number) } })
  })

  test('an unchanged file is read once; a changed one is read again', async () => {
    const { history, readRange } = setup(claudeFile('a', VAULT, 'Once', 1))
    await history.refresh()
    await history.page({ folder: VAULT })
    await history.refresh()
    await history.page({ folder: VAULT })
    expect(readRange).toHaveBeenCalledTimes(1)
    expect(await history.canResume({ path: `${projects}/a.jsonl`, cwd: VAULT })).toBe(true)
    expect(await history.canResume({ path: `${projects}/missing.jsonl`, cwd: VAULT })).toBe(false)
    expect(await history.canResume({ path: `${projects}/a.jsonl`, cwd: `${VAULT}/gone` })).toBe(false)
  })

  test('the archive record survives a reload of the store', () => {
    const storage = {
      loadLocalStorage: (key: string) => (key === AI_SESSION_ARCHIVE_STORAGE_KEY ? { version: 1, items: { 'codex:x': 5, bad: 'no' } } : null),
      saveLocalStorage: jest.fn(),
    }
    const store = new SessionArchiveStore(storage)
    expect(store.has('codex:x')).toBe(true)
    expect(store.has('bad')).toBe(false)
  })
})
