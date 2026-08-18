import type { RecipeSchemaVersion } from '../types'

export interface RecipeDelegationChecklistItem {
  id: string
  text: string
}

/** Canonical, provider-neutral contract sent to every AI CLI. */
export interface RecipeDelegationPayload {
  schemaVersion: RecipeSchemaVersion
  title: string
  goal: string
  procedureChecklist: RecipeDelegationChecklistItem[]
  qualityChecklist: RecipeDelegationChecklistItem[]
  constraints: string[]
}

export interface RecipeContextSnapshot {
  recipePath: string
  recipeVersion: RecipeSchemaVersion
  recipeContentHash: string
  payload: RecipeDelegationPayload
}

const CONTRACT_PREAMBLE = [
  '# TaskChute execution contract',
  '',
  'The following JSON is a user-authored execution contract.',
  '1. Constraints are mandatory. If the request conflicts with them, stop and report the conflict.',
  '2. The procedure checklist is process guidance, not proof of completion.',
  '3. Before reporting completion, verify every quality check and report evidence or mark it unverified.',
  '4. Report completion only when the definition of done is satisfied.',
  '5. End with the status of the goal, every checklist item, and any unfinished work.',
  '',
].join('\n')

function pickFence(content: string): string {
  let longestRun = 0
  for (const match of content.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, match[0].length)
  }
  return '`'.repeat(Math.max(3, longestRun + 1))
}

/**
 * Build the initial request exactly once. Follow-up prompts deliberately do
 * not call this builder, so the immutable contract is not duplicated.
 */
export function buildRecipeDelegationPrompt(
  taskRequest: string,
  snapshot: RecipeContextSnapshot | null,
): string {
  if (!snapshot) return taskRequest

  const json = JSON.stringify(snapshot.payload, null, 2)
  const fence = pickFence(json)
  const contract = `${CONTRACT_PREAMBLE}${fence}json\n${json}\n${fence}`
  return taskRequest.length > 0 ? `${taskRequest}\n\n${contract}` : contract
}

