import type { AiTaskHost } from '../types'
import type { ScopedKey } from '@/i18n'
import { getAiAgent, mapAiAgents } from '../agents'
import type { AiReasoningBudget, AiReasoningMode } from './AiTaskAdvancedOptions'

/** One execution-mode choice and the argv tokens persisted for it. */
export interface AiExecModeVariant {
  id: string
  labelKey: ScopedKey<'taskChuteView'>
  labelFallback: string
  tokens: readonly string[]
}

/**
 * Execution-mode variants of each agent (see `agents/`), shared by the
 * create/edit UI and the argv decoder. Token order is significant because
 * these arrays are written verbatim to `ai_task_args`.
 */
export const AI_EXEC_MODE_VARIANTS: Record<
  AiTaskHost,
  readonly AiExecModeVariant[]
> = mapAiAgents((agent) => agent.execModes)

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
  const reasoning = getAiAgent(host).reasoning
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

    const effort = reasoning?.effortAt(args, index)
    if (reasoning && effort) {
      const range = Array.from({ length: effort.length }, (_, offset) => index + offset)
      if (range.some((position) => position >= args.length || consumed[position])) continue
      const budget = reasoning.budgets.find((candidate) => candidate === effort.value)
      if (effort.value !== undefined && effort.value === reasoning.ultraValue) {
        reasoningMode = 'ultra'
      } else if (budget !== undefined) {
        reasoningMode = 'specified'
        reasoningBudget = budget
      } else {
        continue
      }
      consumeRange(consumed, index, effort.length)
      index += effort.length - 1
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
