import type { AiRunRecord } from '../types'

/** Localized names for runs that have none of their own. */
export interface RunTabFallbackLabels {
  /** "Terminal": a shell session with nothing running and no name. */
  terminal: string
  /** "Untitled run": a task run whose task has no name. */
  untitled: string
}

/**
 * The name a run's tab (and sidebar row) shows.
 *
 *   - a run started from an AI task: the task's name, the same as its sidebar
 *     row, whether it runs in a terminal or headless
 *   - a shell session (＋, split, a resumed agent session): the program
 *     running in it (its title, else its name — see ShellTitleTracker), and
 *     otherwise the session's own name: "Terminal" for ＋ and split, the
 *     conversation's title for a resumed session
 */
export function runTabLabel(
  record: Pick<AiRunRecord, 'host' | 'taskName' | 'terminalLabel'>,
  fallback: RunTabFallbackLabels,
): string {
  if (record.host === 'shell') {
    const label = record.terminalLabel?.trim()
    if (label) return label
    const name = record.taskName.trim()
    return name.length > 0 ? name : fallback.terminal
  }
  const name = record.taskName.trim()
  return name.length > 0 ? name : fallback.untitled
}
