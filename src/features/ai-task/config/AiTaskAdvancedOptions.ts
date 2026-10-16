import type { AiTaskHost } from '../types'
import { getAiAgent, mapAiAgents } from '../agents'

/**
 * The model IDs passed to a CLI as `--model`. The first character cannot be a
 * hyphen, so an ID is never read as a flag.
 */
export const AI_MODEL_ID_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u

export function isSafeAiModelId(modelId: string): boolean {
  return AI_MODEL_ID_SAFE_PATTERN.test(modelId)
}

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
  /** A model the shown list does not have (an older task's model). */
  isUnlisted?: boolean
  /** The efforts the CLI's own list gives for the model, when it gives them. */
  levels?: readonly string[]
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
  // selected. An unlisted model stays conservative (see each agent).
  if (selectedModel === '') return ['automatic']
  const reasoning = getAiAgent(host).reasoning
  if (reasoning === null) return ['automatic']
  return reasoning.modesFor(selectedModel, options.isUnlisted === true, options.levels)
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
