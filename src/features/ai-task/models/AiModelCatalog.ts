/**
 * AI Task - the models each agent offers, kept up to date from its CLI
 *
 * An agent whose CLI can list its models (`modelList`) is asked for them, and
 * the answer is kept on this device (the installed CLIs differ per device, so
 * never in the vault). The list is asked again when it is a day old, the next
 * time a picker opens, or when the user asks. When the CLI cannot be asked,
 * the last list stays; with none yet, the agent's built-in one.
 *
 * A model the list did not have before is new for a week, until it is chosen.
 * The first list ever fetched marks nothing new.
 */

import { getAiAgent } from '../agents'
import type { AiListedModel } from '../agents/AiAgentDefinition'
import type { AiTaskHost } from '../types'

export const AI_MODEL_CATALOG_STORAGE_KEY = 'taskchute-plus.ai-model-catalog'
/** A fetched list this old is asked again the next time a picker opens. */
export const MODEL_LIST_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
/** How long a model that newly appeared is marked new. */
export const MODEL_NEW_FOR_MS = 7 * 24 * 60 * 60 * 1000

export interface AiModelCatalogStorage {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

/** Asks the agent's CLI for its models; throws when it cannot. */
export type AiModelListFetcher = (host: AiTaskHost) => Promise<AiListedModel[]>

/** Reads what model the agent's CLI uses when a task names none; null when its settings say nothing. */
export type AiDefaultModelReader = (host: AiTaskHost) => Promise<string | null>

export interface AiModelCatalogState {
  models: readonly AiListedModel[]
  /** When the shown list was fetched; null while it is the built-in one. */
  fetchedAt: number | null
  fetching: boolean
  /** The last attempt to fetch failed (the previous list is shown). */
  failed: boolean
  /** The agent's CLI can list its models. */
  canFetch: boolean
}

interface StoredHost {
  models: AiListedModel[]
  fetchedAt: number
  /** When each model was first seen on this device; 0 for the first list. */
  firstSeen: Record<string, number>
  /** Models chosen at least once (no longer marked new). */
  chosen: string[]
}

interface Stored {
  version: 1
  hosts: Partial<Record<AiTaskHost, StoredHost>>
}

function isListedModel(value: unknown): value is AiListedModel {
  if (typeof value !== 'object' || value === null) return false
  const model = value as Record<string, unknown>
  return (
    typeof model['id'] === 'string' &&
    typeof model['label'] === 'string' &&
    (model['reasoningLevels'] === undefined ||
      (Array.isArray(model['reasoningLevels']) && model['reasoningLevels'].every((level) => typeof level === 'string')))
  )
}

function readStoredHost(value: unknown): StoredHost | null {
  if (typeof value !== 'object' || value === null) return null
  const host = value as Record<string, unknown>
  if (!Array.isArray(host['models']) || typeof host['fetchedAt'] !== 'number') return null
  const firstSeen: Record<string, number> = {}
  if (typeof host['firstSeen'] === 'object' && host['firstSeen'] !== null) {
    for (const [id, at] of Object.entries(host['firstSeen'] as Record<string, unknown>)) {
      if (typeof at === 'number') firstSeen[id] = at
    }
  }
  return {
    models: host['models'].filter(isListedModel),
    fetchedAt: host['fetchedAt'],
    firstSeen,
    chosen: Array.isArray(host['chosen']) ? host['chosen'].filter((id): id is string => typeof id === 'string') : [],
  }
}

export class AiModelCatalog {
  private readonly stored: Stored
  private readonly fetching = new Map<AiTaskHost, Promise<void>>()
  private readonly failed = new Set<AiTaskHost>()
  private readonly listeners = new Set<(host: AiTaskHost) => void>()
  private readonly defaults = new Map<AiTaskHost, Promise<string | null>>()

  constructor(
    private readonly storage: AiModelCatalogStorage,
    /** Absent where no CLI can be run (then only built-in lists). */
    private readonly fetcher?: AiModelListFetcher,
    private readonly defaultModelReader?: AiDefaultModelReader,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.stored = this.load()
  }

  state(host: AiTaskHost): AiModelCatalogState {
    const kept = this.stored.hosts[host]
    return {
      models: kept?.models ?? getAiAgent(host).models,
      fetchedAt: kept?.fetchedAt ?? null,
      fetching: this.fetching.has(host),
      failed: this.failed.has(host),
      canFetch: this.canFetch(host),
    }
  }

  /** The model with this ID in the list shown for the agent, if it is there. */
  find(host: AiTaskHost, id: string): AiListedModel | undefined {
    return this.state(host).models.find((model) => model.id === id)
  }

  /** Newly appeared within the last week, and not chosen yet. */
  isNew(host: AiTaskHost, id: string): boolean {
    const kept = this.stored.hosts[host]
    const seen = kept?.firstSeen[id]
    if (!kept || seen === undefined || seen === 0 || kept.chosen.includes(id)) return false
    return this.now() - seen < MODEL_NEW_FOR_MS
  }

  /** A chosen model is no longer marked new. */
  markChosen(host: AiTaskHost, id: string): void {
    const kept = this.stored.hosts[host]
    if (!kept || kept.chosen.includes(id) || kept.firstSeen[id] === undefined) return
    kept.chosen.push(id)
    this.save()
  }

  /** Asks the CLI again when the list is missing or a day old. Never waits. */
  refreshIfStale(host: AiTaskHost): void {
    if (!this.canFetch(host) || this.fetching.has(host)) return
    const fetchedAt = this.stored.hosts[host]?.fetchedAt
    if (fetchedAt !== undefined && this.now() - fetchedAt < MODEL_LIST_REFRESH_AFTER_MS) return
    void this.refresh(host)
  }

  /** Asks the CLI for its models now. Resolves when done; never rejects. */
  refresh(host: AiTaskHost): Promise<void> {
    const running = this.fetching.get(host)
    if (running) return running
    const fetcher = this.fetcher
    if (!fetcher || !this.canFetch(host)) return Promise.resolve()
    const work = (async () => {
      try {
        const models = await fetcher(host)
        if (models.length === 0) throw new Error('empty model list')
        this.accept(host, models)
        this.failed.delete(host)
      } catch {
        this.failed.add(host)
      } finally {
        this.fetching.delete(host)
        this.notify(host)
      }
    })()
    this.fetching.set(host, work)
    this.notify(host)
    return work
  }

  /** The model the CLI uses when a task names none, as its settings say (read once). */
  defaultModel(host: AiTaskHost): Promise<string | null> {
    const reader = this.defaultModelReader
    if (!reader) return Promise.resolve(null)
    let reading = this.defaults.get(host)
    if (!reading) {
      reading = reader(host).catch(() => null)
      this.defaults.set(host, reading)
    }
    return reading
  }

  /** Called with the agent whose list or fetch state changed. */
  subscribe(listener: (host: AiTaskHost) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private canFetch(host: AiTaskHost): boolean {
    return this.fetcher !== undefined && getAiAgent(host).modelList !== undefined
  }

  private accept(host: AiTaskHost, models: AiListedModel[]): void {
    const previous = this.stored.hosts[host]
    const at = this.now()
    const firstSeen: Record<string, number> = {}
    for (const model of models) {
      // The first list marks nothing new; later ones, only what they add.
      firstSeen[model.id] = previous?.firstSeen[model.id] ?? (previous ? at : 0)
    }
    this.stored.hosts[host] = {
      models,
      fetchedAt: at,
      firstSeen,
      chosen: (previous?.chosen ?? []).filter((id) => firstSeen[id] !== undefined),
    }
    this.save()
  }

  private notify(host: AiTaskHost): void {
    for (const listener of this.listeners) listener(host)
  }

  private load(): Stored {
    try {
      const raw = this.storage.loadLocalStorage?.(AI_MODEL_CATALOG_STORAGE_KEY)
      if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 1) {
        const hosts: Partial<Record<AiTaskHost, StoredHost>> = {}
        for (const [host, value] of Object.entries((raw as { hosts?: unknown }).hosts ?? {})) {
          const kept = readStoredHost(value)
          if (kept) hosts[host as AiTaskHost] = kept
        }
        return { version: 1, hosts }
      }
    } catch {
      // A broken record is replaced by the next fetch.
    }
    return { version: 1, hosts: {} }
  }

  private save(): void {
    try {
      this.storage.saveLocalStorage?.(AI_MODEL_CATALOG_STORAGE_KEY, this.stored)
    } catch {
      // Device-local storage is optional: the list is asked again next time.
    }
  }
}
