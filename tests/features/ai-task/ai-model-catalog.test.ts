import {
  AI_MODEL_CATALOG_STORAGE_KEY,
  AiModelCatalog,
  MODEL_LIST_REFRESH_AFTER_MS,
  MODEL_NEW_FOR_MS,
} from '@/features/ai-task/models/AiModelCatalog'
import type { AiListedModel } from '@/features/ai-task/agents/AiAgentDefinition'
import type { AiTaskHost } from '@/features/ai-task/types'

const HOUR = 60 * 60 * 1000

function memoryStorage() {
  const data = new Map<string, unknown>()
  return {
    data,
    loadLocalStorage: (key: string) => data.get(key),
    saveLocalStorage: (key: string, value: unknown) => {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
  }
}

function models(...ids: string[]): AiListedModel[] {
  return ids.map((id) => ({ id, label: id.toUpperCase() }))
}

describe('AiModelCatalog', () => {
  let now: number
  let storage: ReturnType<typeof memoryStorage>
  let lists: AiListedModel[][]
  let fetcher: jest.Mock<Promise<AiListedModel[]>, [AiTaskHost]>

  beforeEach(() => {
    now = Date.UTC(2026, 9, 16, 3)
    storage = memoryStorage()
    lists = []
    fetcher = jest.fn<Promise<AiListedModel[]>, [AiTaskHost]>(async () => {
      const next = lists.shift()
      if (!next) throw new Error('offline')
      return next
    })
  })

  const create = () => new AiModelCatalog(storage, fetcher, undefined, () => now)

  test('shows the built-in list until a list is fetched, and Claude Code never fetches', () => {
    const catalog = create()
    expect(catalog.state('codex')).toMatchObject({ fetchedAt: null, canFetch: true, fetching: false })
    expect(catalog.state('codex').models.map((model) => model.id)).toContain('gpt-5.6-sol')
    expect(catalog.state('claude').canFetch).toBe(false)
    catalog.refreshIfStale('claude')
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('the first list marks nothing new; a model added later is new for a week, until chosen', async () => {
    const catalog = create()
    lists.push(models('a', 'b'), models('a', 'b', 'c'))
    await catalog.refresh('cursor')
    expect(catalog.isNew('cursor', 'a')).toBe(false)

    now += 2 * HOUR
    await catalog.refresh('cursor')
    expect(catalog.isNew('cursor', 'c')).toBe(true)
    expect(catalog.isNew('cursor', 'a')).toBe(false)

    now += MODEL_NEW_FOR_MS - HOUR
    expect(catalog.isNew('cursor', 'c')).toBe(true)
    catalog.markChosen('cursor', 'c')
    expect(catalog.isNew('cursor', 'c')).toBe(false)
  })

  test('a new model stops being new after a week', async () => {
    const catalog = create()
    lists.push(models('a'), models('a', 'c'))
    await catalog.refresh('cursor')
    await catalog.refresh('cursor')
    now += MODEL_NEW_FOR_MS
    expect(catalog.isNew('cursor', 'c')).toBe(false)
  })

  test('asks again only when the list is missing or a day old', async () => {
    const catalog = create()
    lists.push(models('a'), models('a', 'b'))
    catalog.refreshIfStale('codex')
    await catalog.refresh('codex')
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += MODEL_LIST_REFRESH_AFTER_MS - 1
    catalog.refreshIfStale('codex')
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += 1
    catalog.refreshIfStale('codex')
    await catalog.refresh('codex')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(catalog.state('codex').models.map((model) => model.id)).toEqual(['a', 'b'])
  })

  test('a failed fetch keeps the previous list and says so; the next success clears it', async () => {
    const catalog = create()
    const seen: string[] = []
    catalog.subscribe((host) => seen.push(`${host}:${String(catalog.state(host).fetching)}`))
    lists.push(models('a'))
    await catalog.refresh('cursor')
    await catalog.refresh('cursor')
    expect(catalog.state('cursor')).toMatchObject({ failed: true, fetchedAt: now })
    expect(catalog.state('cursor').models.map((model) => model.id)).toEqual(['a'])
    expect(seen).toEqual(['cursor:true', 'cursor:false', 'cursor:true', 'cursor:false'])

    lists.push([])
    await catalog.refresh('cursor')
    expect(catalog.state('cursor').failed).toBe(true)
    lists.push(models('b'))
    await catalog.refresh('cursor')
    expect(catalog.state('cursor').failed).toBe(false)
  })

  test('keeps the list on this device across restarts', async () => {
    lists.push(models('a'), models('a', 'c'))
    const first = create()
    await first.refresh('cursor')
    await first.refresh('cursor')
    expect(storage.data.has(AI_MODEL_CATALOG_STORAGE_KEY)).toBe(true)

    const second = create()
    expect(second.state('cursor')).toMatchObject({ fetchedAt: now })
    expect(second.isNew('cursor', 'c')).toBe(true)
    expect(second.find('cursor', 'c')?.label).toBe('C')
  })

  test('a broken record starts over', () => {
    storage.data.set(AI_MODEL_CATALOG_STORAGE_KEY, { version: 1, hosts: { cursor: { models: 'x' } } })
    expect(create().state('cursor').fetchedAt).toBeNull()
  })

  test('reads the default model once per agent', async () => {
    const reader = jest.fn(async (host: AiTaskHost) => (host === 'cursor' ? 'Auto' : null))
    const catalog = new AiModelCatalog(storage, fetcher, reader, () => now)
    expect(await catalog.defaultModel('cursor')).toBe('Auto')
    expect(await catalog.defaultModel('cursor')).toBe('Auto')
    expect(await catalog.defaultModel('codex')).toBeNull()
    expect(reader).toHaveBeenCalledTimes(2)
  })
})
