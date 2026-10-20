import type { ExecCaptureResult } from '../NodeProcessGateway'
import {
  PS_COLUMNS,
  parseForegroundSnapshot,
  parsePsRows,
  type PsRow,
  type ShellForegroundSample,
} from './foregroundSnapshot'

/**
 * Reports the foreground program of live shell sessions, located by their
 * transcript paths: the PTY bootstrap writes each session's tty device to
 * `<transcript>.tty` from inside `script`. All sessions are read with one
 * `ps` call. A null answer means "cannot tell" (the sidecar is not written
 * yet, the tty is gone, or ps failed) — not "at the prompt".
 */
export type ShellForegroundProbe = (
  transcriptPaths: readonly string[],
) => Promise<Map<string, ShellForegroundSample | null>>

export interface ShellForegroundProbeIo {
  /** The tty device path in `<transcript>.tty`, or null while it is unavailable. */
  readTtyPath(transcriptPath: string): Promise<string | null>
  execCapture(command: string, args: string[], timeoutMs: number): Promise<ExecCaptureResult>
}

const PS_PATH = '/bin/ps'
const PS_TIMEOUT_MS = 2000
/** A tty path never changes for a session; remember a bounded number of them. */
const TTY_CACHE_LIMIT = 64

export function createShellForegroundProbe(io: ShellForegroundProbeIo): ShellForegroundProbe {
  const ttyByTranscript = new Map<string, string>()

  const ttyFor = async (transcriptPath: string): Promise<string | null> => {
    const cached = ttyByTranscript.get(transcriptPath)
    if (cached !== undefined) return cached
    const ttyPath = await io.readTtyPath(transcriptPath).catch(() => null)
    if (ttyPath === null) return null
    if (ttyByTranscript.size >= TTY_CACHE_LIMIT) {
      const first = ttyByTranscript.keys().next().value
      if (first !== undefined) ttyByTranscript.delete(first)
    }
    // `ps -t` and its tty column use the device name without /dev/.
    const ttyName = ttyPath.replace(/^\/dev\//u, '')
    ttyByTranscript.set(transcriptPath, ttyName)
    return ttyName
  }

  return async (transcriptPaths) => {
    const answers = new Map<string, ShellForegroundSample | null>()
    const ttys = new Map<string, string>()
    for (const transcriptPath of transcriptPaths) {
      answers.set(transcriptPath, null)
      const tty = await ttyFor(transcriptPath)
      if (tty !== null) ttys.set(transcriptPath, tty)
    }
    if (ttys.size === 0) return answers

    let output: string
    try {
      const result = await io.execCapture(
        PS_PATH,
        ['-t', Array.from(new Set(ttys.values())).join(','), '-o', PS_COLUMNS],
        PS_TIMEOUT_MS,
      )
      // macOS lists the ttys that still exist and exits 0; procps may give
      // up on the whole list when one tty is gone. Either way, no rows for a
      // tty means it cannot be told this time.
      if (result.timedOut || (result.code !== 0 && result.stdout.trim().length === 0)) {
        for (const transcriptPath of ttys.keys()) ttyByTranscript.delete(transcriptPath)
        return answers
      }
      output = result.stdout
    } catch {
      return answers
    }

    const rowsByTty = new Map<string, PsRow[]>()
    for (const row of parsePsRows(output)) {
      const rows = rowsByTty.get(row.tty) ?? []
      rows.push(row)
      rowsByTty.set(row.tty, rows)
    }
    for (const [transcriptPath, tty] of ttys) {
      const rows = rowsByTty.get(tty)
      if (!rows) {
        // The tty closed (the session is ending); look it up afresh next time.
        ttyByTranscript.delete(transcriptPath)
        continue
      }
      answers.set(transcriptPath, parseForegroundSnapshot(rows))
    }
    return answers
  }
}
