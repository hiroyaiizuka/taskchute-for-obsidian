import type { AiTaskHost } from '../types'
import {
  AI_REASONING_BUDGETS,
  type AiReasoningBudget,
  type AiReasoningMode,
} from './AiTaskAdvancedOptions'

/** One execution-mode choice and the argv tokens persisted for it. */
export interface AiExecModeVariant {
  id: string
  labelKey: string
  labelFallback: string
  tokens: readonly string[]
}

/**
 * Execution-mode variants shared by the create/edit UI and the argv decoder.
 * Token order is significant because these arrays are written verbatim to
 * `ai_task_args`.
 */
export const AI_EXEC_MODE_VARIANTS: Record<
  AiTaskHost,
  readonly AiExecModeVariant[]
> = {
  claude: [
    {
      id: 'default',
      labelKey: 'addTask.aiExecModeDefault',
      labelFallback: 'Normal',
      tokens: [],
    },
    {
      id: 'auto',
      labelKey: 'addTask.aiExecModeAuto',
      labelFallback: 'Auto mode',
      tokens: ['--permission-mode', 'auto'],
    },
    {
      id: 'skip-permissions',
      labelKey: 'addTask.aiExecModeSkipPermissions',
      labelFallback: 'Skip permissions',
      tokens: ['--dangerously-skip-permissions'],
    },
  ],
  codex: [
    {
      id: 'default',
      labelKey: 'addTask.aiExecModeDefault',
      labelFallback: 'Normal',
      tokens: [],
    },
    {
      id: 'full-auto',
      labelKey: 'addTask.aiExecModeFullAuto',
      labelFallback: 'Full auto',
      tokens: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
    },
  ],
}

export interface DecodedAiTaskArgs {
  execModeId: string
  modelId: string
  reasoningMode: AiReasoningMode
  reasoningBudget: AiReasoningBudget
  /** Arguments not represented by the modal, retained in their input order. */
  passthroughArgs: string[]
}

export type IsSelectableModelId = (modelId: string) => boolean

const DEFAULT_REASONING_BUDGET: AiReasoningBudget = 'medium'

function tokensMatchAt(
  args: readonly string[],
  start: number,
  tokens: readonly string[],
  consumed: readonly boolean[],
): boolean {
  if (tokens.length === 0 || start + tokens.length > args.length) return false

  return tokens.every(
    (token, offset) =>
      !consumed[start + offset] && args[start + offset] === token,
  )
}

function consumeRange(
  consumed: boolean[],
  start: number,
  length: number,
): void {
  for (let offset = 0; offset < length; offset += 1) {
    consumed[start + offset] = true
  }
}

function isReasoningBudget(
  host: AiTaskHost,
  value: string,
): value is AiReasoningBudget {
  return AI_REASONING_BUDGETS[host].some((candidate) => candidate === value)
}

/**
 * Decode the modal-owned portion of persisted AI CLI arguments.
 *
 * Only complete, recognized token forms are consumed. Unknown model IDs,
 * unsupported values, incomplete pairs, and all other arguments are returned
 * unchanged through `passthroughArgs`, allowing an edit/save round trip to
 * retain options introduced by newer CLI versions.
 */
export function decodeAiTaskArgs(
  host: AiTaskHost,
  args: readonly string[],
  isSelectableModelId: IsSelectableModelId,
): DecodedAiTaskArgs {
  const consumed = args.map(() => false)
  let execModeId = 'default'
  let modelId = ''
  let reasoningMode: AiReasoningMode = 'automatic'
  let reasoningBudget: AiReasoningBudget = DEFAULT_REASONING_BUDGET

  // Consume exact non-default variants. When conflicting known variants are
  // present, the last occurrence mirrors ordinary CLI last-option semantics.
  const nonDefaultVariants = AI_EXEC_MODE_VARIANTS[host].filter(
    (variant) => variant.tokens.length > 0,
  )
  for (let index = 0; index < args.length; index += 1) {
    for (const variant of nonDefaultVariants) {
      if (!tokensMatchAt(args, index, variant.tokens, consumed)) continue
      consumeRange(consumed, index, variant.tokens.length)
      execModeId = variant.id
      index += variant.tokens.length - 1
      break
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    if (consumed[index]) continue

    const token = args[index]
    if (token.startsWith('--model=')) {
      const candidate = token.slice('--model='.length)
      if (candidate !== '' && isSelectableModelId(candidate)) {
        modelId = candidate
        consumed[index] = true
      }
      continue
    }

    if (token === '--model' && index + 1 < args.length && !consumed[index + 1]) {
      const candidate = args[index + 1]
      if (candidate !== '' && isSelectableModelId(candidate)) {
        modelId = candidate
        consumeRange(consumed, index, 2)
        index += 1
      }
      continue
    }

    if (host === 'claude' && token.startsWith('--effort=')) {
      const effort = token.slice('--effort='.length)
      if (effort === 'ultracode') {
        reasoningMode = 'ultra'
        consumed[index] = true
      } else if (isReasoningBudget(host, effort)) {
        reasoningMode = 'specified'
        reasoningBudget = effort
        consumed[index] = true
      }
      continue
    }

    if (
      host === 'codex' &&
      token === '--config' &&
      index + 1 < args.length &&
      !consumed[index + 1]
    ) {
      const configValue = args[index + 1]
      const match = /^model_reasoning_effort="([^"]+)"$/.exec(configValue)
      const effort = match?.[1]
      if (effort === 'ultra') {
        reasoningMode = 'ultra'
        consumeRange(consumed, index, 2)
        index += 1
      } else if (effort !== undefined && isReasoningBudget(host, effort)) {
        reasoningMode = 'specified'
        reasoningBudget = effort
        consumeRange(consumed, index, 2)
        index += 1
      }
    }
  }

  return {
    execModeId,
    modelId,
    reasoningMode,
    reasoningBudget,
    passthroughArgs: args.filter((_, index) => !consumed[index]),
  }
}
