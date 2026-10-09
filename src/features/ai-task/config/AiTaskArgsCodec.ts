import type { AiTaskHost } from '../types'
import type { ScopedKey } from '@/i18n'
import { getAiAgent, mapAiAgents } from '../agents'
import type { AiReasoningBudget, AiReasoningMode } from './AiTaskAdvancedOptions'

/** The execution modes every agent offers, in the order the UI lists them. */
export const AI_EXEC_MODE_IDS = ['manual', 'auto', 'skip-permissions'] as const

export type AiExecModeId = (typeof AI_EXEC_MODE_IDS)[number]

/**
 * The mode a new AI task starts in, for every agent. A task that already
 * exists keeps what its note says: no execution-mode arguments read as
 * manual, so opening and saving it never widens what it may do.
 */
export const DEFAULT_AI_EXEC_MODE: AiExecModeId = 'auto'

const AI_EXEC_MODE_LABELS: Record<
  AiExecModeId,
  { labelKey: ScopedKey<'taskChuteView'>; labelFallback: string }
> = {
  manual: { labelKey: 'addTask.aiExecModeManual', labelFallback: 'Manual' },
  auto: { labelKey: 'addTask.aiExecModeAuto', labelFallback: 'Auto mode' },
  'skip-permissions': {
    labelKey: 'addTask.aiExecModeSkipPermissions',
    labelFallback: 'Skip permissions',
  },
}

/** One execution-mode choice and the argv tokens persisted for it. */
export interface AiExecModeVariant {
  id: AiExecModeId
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
> = mapAiAgents((agent) =>
  AI_EXEC_MODE_IDS.map((id) => ({ id, ...AI_EXEC_MODE_LABELS[id], tokens: agent.execModes[id] })),
)

export interface DecodedAiTaskArgs {
  execModeId: AiExecModeId
  /**
   * The execution-mode tokens exactly as the note has them: the mode's own,
   * an older spelling of it, or none (a note without any reads as manual).
   * Saving with the mode untouched writes these back, so nothing changes.
   */
  execModeTokens: readonly string[]
  /** Whether the note carries the agent's trust-the-folder option. */
  trustFolder: boolean
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
  const agent = getAiAgent(host)
  const reasoning = agent.reasoning
  let execModeId: AiExecModeId = 'manual'
  let execModeTokens: readonly string[] = []
  let trustFolder = false
  let modelId = ''
  let reasoningMode: AiReasoningMode = 'automatic'
  let reasoningBudget: AiReasoningBudget = DEFAULT_REASONING_BUDGET

  // Consume exact non-default variants. When conflicting known variants are
  // present, the last occurrence mirrors ordinary CLI last-option semantics.
  // Older spellings (agent.legacyExecModes) read as the mode they stand for.
  const spellings = [
    ...AI_EXEC_MODE_IDS.map((id) => ({ mode: id, tokens: agent.execModes[id] })),
    ...(agent.legacyExecModes ?? []),
  ].filter((spelling) => spelling.tokens.length > 0)
  for (let index = 0; index < args.length; index += 1) {
    for (const spelling of spellings) {
      if (!tokensMatchAt(args, index, spelling.tokens, consumed)) continue
      consumeRange(consumed, index, spelling.tokens.length)
      execModeId = spelling.mode
      execModeTokens = spelling.tokens
      index += spelling.tokens.length - 1
      break
    }
  }

  const trustTokens = agent.trustFolderArgs ?? []
  for (let index = 0; trustTokens.length > 0 && index < args.length; index += 1) {
    if (!tokensMatchAt(args, index, trustTokens, consumed)) continue
    consumeRange(consumed, index, trustTokens.length)
    trustFolder = true
    index += trustTokens.length - 1
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
    execModeTokens,
    trustFolder,
    modelId,
    reasoningMode,
    reasoningBudget,
    passthroughArgs: args.filter((_, index) => !consumed[index]),
  }
}
