/**
 * AI Task - board view predicate
 *
 * Single source of truth for what the 'human' / 'ai' / 'mixed' board views
 * show: 'human' hides tasks whose frontmatter has a strict `ai_task: true`,
 * 'ai' shows only them, 'mixed' shows everything. Pure and render-only —
 * shared by the task list filter (TaskListRenderer) and the keyboard
 * selection re-validation (TaskChuteView) so the two can never disagree.
 */

import type { AiTaskBoardView } from '../types'

/** Minimal structural slice of TaskInstance consulted by the predicate */
export interface BoardViewFilterableInstance {
  task?: {
    frontmatter?: Record<string, unknown>
  }
}

/** True when the instance is visible under the given board view */
export function matchesAiTaskBoardView(
  inst: BoardViewFilterableInstance,
  view: AiTaskBoardView,
): boolean {
  if (view === 'mixed') return true
  const isAiTask = inst.task?.frontmatter?.['ai_task'] === true
  return isAiTask === (view === 'ai')
}
