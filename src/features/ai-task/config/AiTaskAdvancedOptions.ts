import type { AiTaskHost } from '../types'
import { getAiAgent, mapAiAgents } from '../agents'

export const CUSTOM_AI_MODEL_VALUE = '__custom__'

export interface AiModelPreset {
  id: string
  label: string
}

export type AiReasoningMode = 'automatic' | 'specified' | 'ultra'
export type AiReasoningBudget =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export interface AiReasoningModelOptions {
  /**
   * Persistent custom models carry their real ID instead of the legacy
   * `__custom__` sentinel, so callers must be able to identify them without
   * inferring capabilities from an unknown ID.
   */
  isCustomModel?: boolean
}

/** Built-in model choices of each agent (see `agents/`). */
export const AI_MODEL_PRESETS: Record<AiTaskHost, readonly AiModelPreset[]> =
  mapAiAgents((agent) => agent.models)

/** Reasoning budgets each agent takes; empty when it has no effort option. */
export const AI_REASONING_BUDGETS: Record<
  AiTaskHost,
  readonly AiReasoningBudget[]
> = mapAiAgents((agent) => agent.reasoning?.budgets ?? [])

export function getAvailableReasoningModes(
  host: AiTaskHost,
  selectedModel: string,
  options: AiReasoningModelOptions = {},
): readonly AiReasoningMode[] {
  // "Default" resolves through the user's CLI configuration. It may point to
  // a model outside our preset capability table (for example Haiku or Luna),
  // so only promise explicit reasoning controls after a concrete model is
  // selected. Custom remains separately conservative (see each agent).
  if (selectedModel === '') return ['automatic']
  const reasoning = getAiAgent(host).reasoning
  if (reasoning === null) return ['automatic']

  const isCustomModel =
    options.isCustomModel === true || selectedModel === CUSTOM_AI_MODEL_VALUE
  return reasoning.modesFor(selectedModel, isCustomModel)
}

export function buildReasoningArgs(
  host: AiTaskHost,
  mode: AiReasoningMode,
  budget: string,
): string[] {
  if (mode === 'automatic') return []
  const reasoning = getAiAgent(host).reasoning
  if (reasoning === null) return []
  if (mode === 'ultra') return reasoning.effortArgs(reasoning.ultraValue)
  if (mode !== 'specified') return []
  if (!reasoning.budgets.some((candidate) => candidate === budget)) return []
  return reasoning.effortArgs(budget)
}
