import type { AiTaskHost } from '../types'

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

/**
 * Built-in model choices verified against the local CLIs and their official
 * model documentation on 2026-07-13. Custom remains available because model
 * catalogs and private-provider IDs can change independently of the plugin.
 */
export const AI_MODEL_PRESETS: Record<AiTaskHost, readonly AiModelPreset[]> = {
  claude: [
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
}

export const AI_REASONING_BUDGETS: Record<
  AiTaskHost,
  readonly AiReasoningBudget[]
> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
}

export function getAvailableReasoningModes(
  host: AiTaskHost,
  selectedModel: string,
  options: AiReasoningModelOptions = {},
): readonly AiReasoningMode[] {
  // "Default" resolves through the user's CLI configuration. It may point to
  // a model outside our preset capability table (for example Haiku or Luna),
  // so only promise explicit reasoning controls after a concrete model is
  // selected. Custom remains separately conservative below.
  if (selectedModel === '') return ['automatic']

  const isCustomModel =
    options.isCustomModel === true || selectedModel === CUSTOM_AI_MODEL_VALUE

  if (host === 'claude') {
    // The current Claude Code docs do not list Haiku 4.5 as supporting
    // effort. Custom remains permissive for ordinary effort because a private
    // provider/model may support it, but does not advertise Ultracode.
    if (selectedModel === 'claude-haiku-4-5') return ['automatic']
    if (isCustomModel) {
      return ['automatic', 'specified']
    }
    return ['automatic', 'specified', 'ultra']
  }

  // Codex 0.144.1's bundled catalog advertises Ultra for Sol and Terra, but
  // not Luna. A custom provider/model is unknown, so do not promise Ultra.
  return selectedModel === 'gpt-5.6-luna' || isCustomModel
    ? ['automatic', 'specified']
    : ['automatic', 'specified', 'ultra']
}

export function buildReasoningArgs(
  host: AiTaskHost,
  mode: AiReasoningMode,
  budget: string,
): string[] {
  if (mode === 'automatic') return []
  if (mode === 'ultra') {
    return host === 'claude'
      ? ['--effort=ultracode']
      : ['--config', 'model_reasoning_effort="ultra"']
  }
  if (mode !== 'specified') return []
  if (!AI_REASONING_BUDGETS[host].some((candidate) => candidate === budget)) {
    return []
  }

  if (host === 'claude') {
    return [`--effort=${budget}`]
  }

  // Codex parses --config values as TOML. Keep the quotes inside this argv
  // token so the effort is unambiguously a TOML string in both PTY and exec.
  return ['--config', `model_reasoning_effort="${budget}"`]
}
