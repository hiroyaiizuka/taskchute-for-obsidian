/**
 * What TaskChute tells the user about a terminal's machinery.
 *
 * A terminal whose machinery failed used to show nothing: a red tab, an empty
 * screen and a blinking cursor that swallowed keystrokes. These notices are
 * carried on the run record and shown by the pane beside the terminal (and as
 * an Obsidian Notice) — never written into the PTY stream, where they would
 * corrupt a full-screen TUI such as Claude Code and replay after a reload.
 */

import { t } from '@/i18n'
import type { AiTerminalNotice } from '../types'
import type { AiTerminalFailureKind } from './dispatchers/Dispatcher'

let lastNoticeSeq = 0

/**
 * Strictly increasing, so two notices raised in the same millisecond (a lost
 * connection and the input it dropped) are still two notices. Seeded from
 * the clock so a plugin reload, which restarts this module, keeps counting
 * up past notices already on retained records.
 */
function nextNoticeSeq(): number {
  lastNoticeSeq = Math.max(Date.now(), lastNoticeSeq + 1)
  return lastNoticeSeq
}

/** Why a terminal session never got a process. */
export function terminalFailureNotice(
  kind: AiTerminalFailureKind,
  errorMessage: string | undefined,
): AiTerminalNotice {
  const message =
    kind === 'node-not-found'
      ? t(
        'taskChuteView.aiTask.terminalNotice.nodeNotFound',
        'Node.js was not found. The terminal needs Node.js to run. Install Node.js, then open the terminal again.',
      )
      : t('taskChuteView.aiTask.terminalNotice.startFailed', 'The terminal could not start: {error}', {
        error: errorMessage ?? kind,
      })
  return { kind: 'start-failed', message, seq: nextNoticeSeq() }
}

/** The session stopped answering; its termination is being confirmed. */
export function terminalConnectionLostNotice(quiet = false): AiTerminalNotice {
  return {
    quiet,
    kind: 'connection-lost',
    message: t(
      'taskChuteView.aiTask.terminalNotice.connectionLost',
      'Lost the connection to this terminal. Confirming that its process has stopped…',
    ),
    seq: nextNoticeSeq(),
  }
}

/** Keystrokes could not be delivered to the session. */
export function terminalInputDroppedNotice(): AiTerminalNotice {
  return {
    kind: 'input-dropped',
    message: t(
      'taskChuteView.aiTask.terminalNotice.inputDropped',
      'Input was not sent: the connection to this terminal is lost.',
    ),
    seq: nextNoticeSeq(),
  }
}

/** The session could not be reached and its run was marked interrupted. */
export function terminalInterruptedNotice(quiet = false): AiTerminalNotice {
  return {
    quiet,
    kind: 'interrupted',
    message: t(
      'taskChuteView.aiTask.terminalNotice.interrupted',
      'This terminal can no longer be reached, so it was stopped.',
    ),
    seq: nextNoticeSeq(),
  }
}
