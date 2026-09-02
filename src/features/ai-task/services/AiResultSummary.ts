/**
 * AI Task - result event summary
 *
 * One formatting of a run's terminating `result` event, shared by the log
 * note and the run pane. The event carries `text` — the CLI's own copy of the
 * final assistant message — which both surfaces must NOT render as body text:
 * the same words already arrived as an `assistant-text` event, and printing
 * them again showed every answer twice in the pane.
 */

import type { AiResultEvent } from '../types'

/** `success (cost $0.01, 2 turns)` — label plus whatever metadata is present. */
export function formatAiResultSummary(event: AiResultEvent): string {
  const label = event.subtype ?? (event.isError ? 'error' : 'success')
  const details: string[] = []
  if (event.totalCostUsd !== undefined) details.push(`cost $${event.totalCostUsd}`)
  if (event.numTurns !== undefined) details.push(`${event.numTurns} turns`)
  return details.length > 0 ? `${label} (${details.join(', ')})` : label
}
