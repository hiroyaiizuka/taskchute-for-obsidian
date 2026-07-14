import {
  AI_MODEL_PRESETS,
  type AiModelPreset,
} from '../config/AiTaskAdvancedOptions'
import type { AiTaskHost } from '../types'

/** Device-local custom model catalog, deliberately separate from task notes. */
export const AI_CUSTOM_MODEL_STORAGE_KEY =
  'taskchute-plus.ai-task-custom-models'

/**
 * Safe CLI model-id shape carried from TaskChute for Agent.
 * The first character cannot be a hyphen, preventing flag injection.
 */
export const AI_MODEL_ID_SAFE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/

export function isSafeAiModelId(modelId: string): boolean {
  return AI_MODEL_ID_SAFE_PATTERN.test(modelId)
}

export interface AiCustomModel {
  id: string
  label: string
  description?: string
}

export interface AiCustomModelsByHost {
  claude: AiCustomModel[]
  codex: AiCustomModel[]
}

/** Duck-typed App#loadLocalStorage / App#saveLocalStorage bridge. */
export interface AiCustomModelStorageBridge {
  loadLocalStorage?: (key: string) => unknown
  saveLocalStorage?: (key: string, value: unknown) => void
}

export type AiCustomModelMutationError =
  | 'invalid-id'
  | 'invalid-label'
  | 'invalid-description'
  | 'duplicate-id'
  | 'not-found'

export type AiCustomModelMutationResult =
  | { ok: true; model: AiCustomModel }
  | { ok: false; error: AiCustomModelMutationError }

export type AiCustomModelUpdate = Partial<Omit<AiCustomModel, 'id'>>

type BuiltInModelCatalog = Record<
  AiTaskHost,
  readonly Pick<AiModelPreset, 'id' | 'label'>[]
>

const AI_TASK_HOSTS: readonly AiTaskHost[] = ['claude', 'codex']

function emptyState(): AiCustomModelsByHost {
  return { claude: [], codex: [] }
}

function cloneModel(model: AiCustomModel): AiCustomModel {
  return {
    id: model.id,
    label: model.label,
    ...(model.description !== undefined
      ? { description: model.description }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeModel(value: unknown):
  | { ok: true; model: AiCustomModel }
  | { ok: false; error: AiCustomModelMutationError } {
  if (!isRecord(value)) return { ok: false, error: 'invalid-id' }

  const id = typeof value['id'] === 'string' ? value['id'].trim() : ''
  if (!isSafeAiModelId(id)) return { ok: false, error: 'invalid-id' }

  const label =
    typeof value['label'] === 'string' ? value['label'].trim() : ''
  if (label.length === 0) return { ok: false, error: 'invalid-label' }

  const rawDescription = value['description']
  if (rawDescription !== undefined && typeof rawDescription !== 'string') {
    return { ok: false, error: 'invalid-description' }
  }
  const description = rawDescription?.trim()

  return {
    ok: true,
    model: {
      id,
      label,
      ...(description ? { description } : {}),
    },
  }
}

/**
 * Host-scoped custom model catalog with defensive device-local persistence.
 *
 * Task notes keep only the selected literal `--model=<id>` argv token. The
 * human-friendly label/description catalog remains per-device, matching the
 * reference app and avoiding vault mutations for a UI preference.
 */
export class AiCustomModelStore {
  private modelsByHost: AiCustomModelsByHost

  constructor(
    private readonly storage: AiCustomModelStorageBridge = {},
    private readonly builtInModels: BuiltInModelCatalog = AI_MODEL_PRESETS,
  ) {
    this.modelsByHost = this.load()
  }

  getCustomModels(host: AiTaskHost): AiCustomModel[] {
    return this.modelsByHost[host].map(cloneModel)
  }

  getState(): AiCustomModelsByHost {
    return {
      claude: this.getCustomModels('claude'),
      codex: this.getCustomModels('codex'),
    }
  }

  hasModelId(host: AiTaskHost, modelId: string): boolean {
    const normalizedId = modelId.trim()
    return (
      this.builtInModels[host].some((model) => model.id === normalizedId) ||
      this.modelsByHost[host].some((model) => model.id === normalizedId)
    )
  }

  validateNewModelId(
    host: AiTaskHost,
    modelId: string,
  ): Extract<AiCustomModelMutationError, 'invalid-id' | 'duplicate-id'> | null {
    const normalizedId = modelId.trim()
    if (!isSafeAiModelId(normalizedId)) return 'invalid-id'
    return this.hasModelId(host, normalizedId) ? 'duplicate-id' : null
  }

  add(host: AiTaskHost, value: AiCustomModel): AiCustomModelMutationResult {
    const normalized = normalizeModel(value)
    if (!normalized.ok) return normalized

    const idError = this.validateNewModelId(host, normalized.model.id)
    if (idError) return { ok: false, error: idError }

    this.modelsByHost = {
      ...this.modelsByHost,
      [host]: [...this.modelsByHost[host], normalized.model],
    }
    this.persist()
    return { ok: true, model: cloneModel(normalized.model) }
  }

  update(
    host: AiTaskHost,
    modelId: string,
    updates: AiCustomModelUpdate,
  ): AiCustomModelMutationResult {
    const normalizedId = modelId.trim()
    const index = this.modelsByHost[host].findIndex(
      (model) => model.id === normalizedId,
    )
    if (index < 0) return { ok: false, error: 'not-found' }

    const current = this.modelsByHost[host][index]
    let label = current.label
    if (Object.prototype.hasOwnProperty.call(updates, 'label')) {
      if (typeof updates.label !== 'string' || updates.label.trim().length === 0) {
        return { ok: false, error: 'invalid-label' }
      }
      label = updates.label.trim()
    }

    let description = current.description
    if (Object.prototype.hasOwnProperty.call(updates, 'description')) {
      if (
        updates.description !== undefined &&
        typeof updates.description !== 'string'
      ) {
        return { ok: false, error: 'invalid-description' }
      }
      description = updates.description?.trim() || undefined
    }

    const nextModel: AiCustomModel = {
      id: current.id,
      label,
      ...(description ? { description } : {}),
    }
    const nextHostModels = [...this.modelsByHost[host]]
    nextHostModels[index] = nextModel
    this.modelsByHost = { ...this.modelsByHost, [host]: nextHostModels }
    this.persist()
    return { ok: true, model: cloneModel(nextModel) }
  }

  remove(host: AiTaskHost, modelId: string): boolean {
    const normalizedId = modelId.trim()
    const nextHostModels = this.modelsByHost[host].filter(
      (model) => model.id !== normalizedId,
    )
    if (nextHostModels.length === this.modelsByHost[host].length) return false

    this.modelsByHost = { ...this.modelsByHost, [host]: nextHostModels }
    this.persist()
    return true
  }

  private load(): AiCustomModelsByHost {
    let stored: unknown
    try {
      stored = this.storage.loadLocalStorage?.(AI_CUSTOM_MODEL_STORAGE_KEY)
    } catch {
      return emptyState()
    }
    if (!isRecord(stored)) return emptyState()

    const state = emptyState()
    for (const host of AI_TASK_HOSTS) {
      const rawModels = stored[host]
      if (!Array.isArray(rawModels)) continue

      const seenIds = new Set(this.builtInModels[host].map((model) => model.id))
      for (const rawModel of rawModels) {
        const normalized = normalizeModel(rawModel)
        if (!normalized.ok || seenIds.has(normalized.model.id)) continue
        seenIds.add(normalized.model.id)
        state[host].push(normalized.model)
      }
    }
    return state
  }

  private persist(): void {
    try {
      this.storage.saveLocalStorage?.(
        AI_CUSTOM_MODEL_STORAGE_KEY,
        this.getState(),
      )
    } catch {
      // Device-local storage is optional; keep the in-memory catalog usable.
    }
  }
}
