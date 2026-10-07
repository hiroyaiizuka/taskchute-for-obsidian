import { TFile } from 'obsidian'
import DayStatePersistenceService from '@/services/DayStatePersistenceService'
import DayStateStoreService from '@/services/DayStateStoreService'
import { mergeDayComments, normalizeDayComments, visibleComments } from '@/services/dayState/comments'
import type { DayComment, DayState, TaskChutePluginLike } from '@/types'

const comment = (overrides: Partial<DayComment> & { id: string }): DayComment => ({
  at: 1000,
  text: 'text',
  updatedAt: 1000,
  ...overrides,
})

/** A day as older versions of the plugin wrote it: no `comments` field at all. */
const legacyDay = () => ({
  hiddenRoutines: [],
  deletedInstances: [{ path: 'TASKS/a.md', deletionType: 'temporary', timestamp: 1 }],
  duplicatedInstances: [],
  slotOverrides: { 'tc-task-1': '8:00-12:00' },
  orders: { 'tc-task-1::8:00-12:00': 100 },
})

function createPlugin() {
  const store = new Map<string, string>()
  const createFile = (path: string) => {
    const file = new TFile()
    file.path = path
    Object.setPrototypeOf(file, TFile.prototype)
    return file
  }
  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => (store.has(path) ? createFile(path) : null)),
    read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
    create: jest.fn(async (path: string, content: string) => {
      store.set(path, content)
      return createFile(path)
    }),
    modify: jest.fn(async (file: TFile, content: string) => {
      store.set(file.path, content)
    }),
  }
  const plugin = {
    app: { vault },
    settings: { useOrderBasedSort: true, slotKeys: {} },
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn().mockResolvedValue(undefined),
      getLogYearPath: jest.fn((year: string | number) => `LOGS/${year}`),
      ensureYearFolder: jest.fn(async () => undefined),
      validatePath: jest.fn(() => ({ valid: true })),
    },
    routineAliasService: { loadAliases: jest.fn().mockResolvedValue({}) },
    dayStateService: {} as unknown,
    saveSettings: jest.fn().mockResolvedValue(undefined),
  } as unknown as TaskChutePluginLike
  return { plugin, store, vault }
}

const monthFile = (days: Record<string, unknown>) =>
  JSON.stringify({ days, metadata: { version: '1.0', lastUpdated: '2026-10-01T00:00:00.000Z' } }, null, 2)

const readDay = (store: Map<string, string>, dateKey: string): Record<string, unknown> => {
  const saved = JSON.parse(store.get(`LOGS/${dateKey.slice(0, 7)}-state.json`)!) as {
    days: Record<string, Record<string, unknown>>
  }
  return saved.days[dateKey]
}

describe('normalizeDayComments (older and damaged data)', () => {
  it('reads a missing field as no comments', () => {
    expect(normalizeDayComments(undefined)).toBeUndefined()
  })

  it.each([null, {}, 'comments', 3])('reads a non-array (%p) as no comments', (value) => {
    expect(normalizeDayComments(value)).toBeUndefined()
  })

  it('drops only the entries it cannot use', () => {
    const result = normalizeDayComments([
      null,
      'text',
      { at: 1, text: 'no id', updatedAt: 1 },
      { id: '', at: 1, text: 'blank id', updatedAt: 1 },
      { id: 'b', at: 1, text: 42, updatedAt: 1 },
      { id: 'c', at: '10:00', text: 'time as text', updatedAt: 1 },
      { id: 'ok', at: 5, text: 'kept', updatedAt: 6 },
    ])
    expect(result).toEqual([{ id: 'ok', at: 5, text: 'kept', updatedAt: 6 }])
  })

  it('fills a missing updatedAt from at', () => {
    expect(normalizeDayComments([{ id: 'a', at: 5, text: 'x' }])).toEqual([
      { id: 'a', at: 5, text: 'x', updatedAt: 5 },
    ])
  })

  it('treats a blank or non-string instanceId as a comment on the day', () => {
    const result = normalizeDayComments([
      { id: 'a', at: 1, text: 'x', instanceId: '' },
      { id: 'b', at: 1, text: 'y', instanceId: 7 },
    ])
    expect(result?.every((c) => c.instanceId === undefined)).toBe(true)
  })

  it('treats a non-number deletedAt as not deleted', () => {
    const [entry] = normalizeDayComments([{ id: 'a', at: 1, text: 'x', deletedAt: 'yesterday' }])!
    expect(entry.deletedAt).toBeUndefined()
  })

  it('keeps only the known fields', () => {
    const [entry] = normalizeDayComments([{ id: 'a', at: 1, text: 'x', updatedAt: 2, color: 'red' }])!
    expect(entry).toEqual({ id: 'a', at: 1, text: 'x', updatedAt: 2 })
  })

  it('keeps the newer of two entries with the same id', () => {
    const result = normalizeDayComments([
      { id: 'a', at: 1, text: 'old', updatedAt: 2 },
      { id: 'a', at: 1, text: 'new', updatedAt: 3 },
    ])
    expect(result).toEqual([{ id: 'a', at: 1, text: 'new', updatedAt: 3 }])
  })
})

describe('mergeDayComments (between devices)', () => {
  it('keeps comments that exist on one side only', () => {
    const { merged, hasConflicts } = mergeDayComments([comment({ id: 'a' })], [comment({ id: 'b' })])
    expect(merged.map((c) => c.id).sort()).toEqual(['a', 'b'])
    expect(hasConflicts).toBe(false)
  })

  it('takes the newer rewrite', () => {
    const { merged, hasConflicts } = mergeDayComments(
      [comment({ id: 'a', text: 'old', updatedAt: 1 })],
      [comment({ id: 'a', text: 'new', updatedAt: 2 })],
    )
    expect(merged[0].text).toBe('new')
    expect(hasConflicts).toBe(true)
  })

  it('lets a newer deletion win over an older copy', () => {
    const { merged } = mergeDayComments(
      [comment({ id: 'a', updatedAt: 1 })],
      [comment({ id: 'a', updatedAt: 2, deletedAt: 2 })],
    )
    expect(visibleComments(merged)).toEqual([])
  })

  it('lets a later restore win over the deletion', () => {
    const { merged } = mergeDayComments(
      [comment({ id: 'a', updatedAt: 2, deletedAt: 2 })],
      [comment({ id: 'a', updatedAt: 3 })],
    )
    expect(visibleComments(merged).map((c) => c.id)).toEqual(['a'])
  })

  it('keeps the local entry on a tie', () => {
    const { merged } = mergeDayComments(
      [comment({ id: 'a', text: 'local', updatedAt: 5 })],
      [comment({ id: 'a', text: 'remote', updatedAt: 5 })],
    )
    expect(merged[0].text).toBe('local')
  })

  it('gives an empty result when neither side has comments', () => {
    expect(mergeDayComments(undefined, undefined)).toEqual({ merged: [], hasConflicts: false })
  })
})

describe('visibleComments', () => {
  const all = [
    comment({ id: 'day-old', at: 1 }),
    comment({ id: 'day-new', at: 3 }),
    comment({ id: 'day-deleted', at: 4, deletedAt: 5 }),
    comment({ id: 'task', at: 2, instanceId: 'i-1' }),
  ]

  it("lists the day's comments, newest first, without deleted ones", () => {
    expect(visibleComments(all).map((c) => c.id)).toEqual(['day-new', 'day-old'])
  })

  it("lists one instance's comments", () => {
    expect(visibleComments(all, 'i-1').map((c) => c.id)).toEqual(['task'])
    expect(visibleComments(all, 'i-2')).toEqual([])
  })
})

describe('DayStatePersistenceService with comments', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-07T03:00:00.000Z') })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('reads a file from before comments existed', async () => {
    const { plugin, store } = createPlugin()
    store.set('LOGS/2026-10-state.json', monthFile({ '2026-10-07': legacyDay() }))
    const service = new DayStatePersistenceService(plugin)
    const day = await service.loadDay(new Date(2026, 9, 7))
    expect(day.comments).toBeUndefined()
    expect(day.orders).toEqual({ 'tc-task-1::8:00-12:00': 100 })
    expect(day.deletedInstances).toHaveLength(1)
  })

  it('does not add an empty comments field when an older day is saved again', async () => {
    const { plugin, store } = createPlugin()
    store.set('LOGS/2026-10-state.json', monthFile({ '2026-10-07': legacyDay() }))
    const service = new DayStatePersistenceService(plugin)
    const date = new Date(2026, 9, 7)
    const day = await service.loadDay(date)
    await service.saveDay(date, { ...day, orders: { ...day.orders, 'tc-task-2::none': 200 } })
    expect(readDay(store, '2026-10-07')).not.toHaveProperty('comments')
  })

  it('writes and reads comments back', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)
    const date = new Date(2026, 9, 7)
    const day = await service.loadDay(date)
    const saved = [comment({ id: 'a', text: 'hello' }), comment({ id: 'b', instanceId: 'i-1' })]
    await service.saveDay(date, { ...day, comments: saved })
    expect(readDay(store, '2026-10-07').comments).toEqual(saved)

    const fresh = new DayStatePersistenceService(plugin)
    expect((await fresh.loadDay(date)).comments).toEqual(saved)
  })

  it('writes when only the comments changed', async () => {
    const { plugin, vault } = createPlugin()
    const service = new DayStatePersistenceService(plugin)
    const date = new Date(2026, 9, 7)
    const day = await service.loadDay(date)
    await service.saveDay(date, { ...day, comments: [comment({ id: 'a' })] })
    const writes = vault.modify.mock.calls.length + vault.create.mock.calls.length
    await service.updateDay(date, (state) => {
      state.comments = [comment({ id: 'a', text: 'rewritten', updatedAt: 2000 })]
    })
    expect(vault.modify.mock.calls.length + vault.create.mock.calls.length).toBe(writes + 1)
  })

  it('takes in comments written on another device (mergeExternalChange)', async () => {
    const { plugin, store } = createPlugin()
    const service = new DayStatePersistenceService(plugin)
    const date = new Date(2026, 9, 7)
    const day = await service.loadDay(date)
    await service.saveDay(date, { ...day, comments: [comment({ id: 'local' })] })

    store.set(
      'LOGS/2026-10-state.json',
      monthFile({ '2026-10-07': { ...legacyDay(), comments: [comment({ id: 'remote', text: 'from phone' })] } }),
    )
    const result = await service.mergeExternalChange('2026-10')
    expect(result.affectedDateKeys).toContain('2026-10-07')
    const merged = await service.loadDay(date)
    expect(merged.comments?.map((c) => c.id).sort()).toEqual(['local', 'remote'])
  })

  it('keeps comments from both sides when saving a month (mergeAndSaveMonth)', async () => {
    const { plugin, store } = createPlugin()
    store.set(
      'LOGS/2026-10-state.json',
      monthFile({ '2026-10-07': { ...legacyDay(), comments: [comment({ id: 'disk' })] } }),
    )
    const service = new DayStatePersistenceService(plugin)
    const local: DayState = { ...(legacyDay() as unknown as DayState), comments: [comment({ id: 'local' })] }
    await service.mergeAndSaveMonth('2026-10', new Map([['2026-10-07', local]]))
    const ids = (readDay(store, '2026-10-07').comments as DayComment[]).map((c) => c.id).sort()
    expect(ids).toEqual(['disk', 'local'])
  })

  it('keeps an older file without comments free of the field after a merge', async () => {
    const { plugin, store } = createPlugin()
    store.set('LOGS/2026-10-state.json', monthFile({ '2026-10-07': legacyDay() }))
    const service = new DayStatePersistenceService(plugin)
    await service.mergeAndSaveMonth('2026-10', new Map([['2026-10-07', legacyDay() as unknown as DayState]]))
    expect(readDay(store, '2026-10-07')).not.toHaveProperty('comments')
  })
})

describe('DayStateStoreService comments', () => {
  const createStore = (initial?: DayState) => {
    const empty = (): DayState => ({ hiddenRoutines: [], deletedInstances: [], duplicatedInstances: [], slotOverrides: {}, orders: {} })
    const saveDay = jest.fn<Promise<void>, [Date, DayState]>(async () => undefined)
    const store = new DayStateStoreService({
      dayStateService: {
        loadDay: jest.fn(async () => initial ?? empty()),
        saveDay,
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
        getDateFromKey: jest.fn(),
        renameTaskPath: jest.fn(),
      },
      getCurrentDateString: () => '2026-10-07',
      parseDateString: (key: string) => new Date(`${key}T00:00:00`),
    })
    return { store, saveDay }
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-07T03:00:00.000Z') })
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('gives no comments for a day from before comments existed', async () => {
    const { store } = createStore(legacyDay() as unknown as DayState)
    await store.ensure()
    expect(store.getComments()).toEqual([])
    expect(store.getComments({ instanceId: 'i-1' })).toEqual([])
  })

  it("adds comments on the day and on an instance, kept apart", async () => {
    const { store } = createStore()
    await store.ensure()
    const day = store.addComment({ text: '  on the day  ' })
    jest.advanceTimersByTime(1000)
    store.addComment({ text: 'on the task', instanceId: 'i-1' })
    expect(day?.text).toBe('on the day')
    expect(store.getComments().map((c) => c.text)).toEqual(['on the day'])
    expect(store.getComments({ instanceId: 'i-1' }).map((c) => c.text)).toEqual(['on the task'])
  })

  it('ignores blank text', async () => {
    const { store } = createStore()
    await store.ensure()
    expect(store.addComment({ text: '   ' })).toBeNull()
    expect(store.getComments()).toEqual([])
  })

  it('lists newest first', async () => {
    const { store } = createStore()
    await store.ensure()
    store.addComment({ text: 'first' })
    jest.advanceTimersByTime(60_000)
    store.addComment({ text: 'second' })
    expect(store.getComments().map((c) => c.text)).toEqual(['second', 'first'])
  })

  it('rewrites a comment and moves updatedAt forward', async () => {
    const { store } = createStore()
    await store.ensure()
    const added = store.addComment({ text: 'draft' })!
    const updated = store.updateComment(added.id, 'final')!
    expect(updated.text).toBe('final')
    expect(updated.at).toBe(added.at)
    expect(updated.updatedAt).toBeGreaterThan(added.updatedAt)
  })

  it('deletes when rewritten to blank, and can be restored', async () => {
    const { store } = createStore()
    await store.ensure()
    const added = store.addComment({ text: 'oops' })!
    const removed = store.updateComment(added.id, '  ')
    expect(removed?.deletedAt).toBeDefined()
    expect(store.getComments()).toEqual([])
    store.restoreComment(added.id)
    expect(store.getComments().map((c) => c.text)).toEqual(['oops'])
  })

  it('keeps a tombstone so the deletion can reach other devices', async () => {
    const { store } = createStore()
    const state = await store.ensure()
    const added = store.addComment({ text: 'gone' })!
    store.deleteComment(added.id)
    expect(state.comments?.find((c) => c.id === added.id)?.deletedAt).toBeDefined()
  })

  it('does not cache an empty day when reading comments of a day not loaded yet', async () => {
    const stored: DayState = {
      ...(legacyDay() as unknown as DayState),
      comments: [comment({ id: 'kept', text: 'stored' })],
    }
    const { store } = createStore(stored)
    expect(store.getComments({ dateKey: '2026-10-07' })).toEqual([])
    await store.ensure('2026-10-07')
    expect(store.getComments({ dateKey: '2026-10-07' }).map((c) => c.text)).toEqual(['stored'])
  })

  it('loads the day before adding, so the stored day is not replaced', async () => {
    const stored: DayState = {
      ...(legacyDay() as unknown as DayState),
      comments: [comment({ id: 'kept', text: 'stored' })],
    }
    const { store, saveDay } = createStore(stored)
    await store.addCommentTo('2026-10-07', { text: 'new' })
    await Promise.resolve()
    expect(store.getComments({ dateKey: '2026-10-07' }).map((c) => c.text).sort()).toEqual(['new', 'stored'])
    const saved = saveDay.mock.calls.at(-1)?.[1]
    expect(saved?.orders).toEqual({ 'tc-task-1::8:00-12:00': 100 })
  })

  it('returns null for an unknown id', async () => {
    const { store } = createStore()
    await store.ensure()
    expect(store.updateComment('missing', 'x')).toBeNull()
    expect(store.deleteComment('missing')).toBeNull()
    expect(store.restoreComment('missing')).toBeNull()
  })
})
