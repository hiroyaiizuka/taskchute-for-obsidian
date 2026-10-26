import type { ShellForegroundProbe } from './ShellForegroundProbe'
import { programNameFromWindowsCommandLine, type ShellForegroundSample } from './foregroundSnapshot'

/**
 * The Windows counterpart of the ps-based probe. The ConPTY host writes what
 * runs in each session's foreground to `<transcript>.fg` (see
 * ForegroundWatcher in ConPtyHostSource): an empty line at the prompt, else
 * `<pid>\t<started, ms since the epoch>\t<command line>`. A missing or
 * unreadable file means "cannot tell".
 */
export interface WindowsShellForegroundProbeIo {
  /** The sidecar's text, or null while it is unavailable. */
  readForeground(transcriptPath: string): Promise<string | null>
  now?: () => number
}

/**
 * The host refreshes the sidecar every second (ForegroundPollMs); with the
 * write, an answer read now was true at least this long ago.
 */
export const WINDOWS_FOREGROUND_STALENESS_MS = 1500

export function parseWindowsForeground(text: string): ShellForegroundSample | null {
  const line = text.replace(/\r?\n$/u, '')
  if (line.length === 0) return { program: null }
  const [pidText = '', startedText = '', ...rest] = line.split('\t')
  const pid = Number(pidText)
  const startedAt = Number(startedText)
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
    return null
  }
  const name = programNameFromWindowsCommandLine(rest.join('\t'))
  return { program: { pid, name, startedAt } }
}

export function createWindowsShellForegroundProbe(
  io: WindowsShellForegroundProbeIo,
): ShellForegroundProbe {
  const now = io.now ?? (() => Date.now())
  return async (transcriptPaths) => {
    const answers = new Map<string, ShellForegroundSample | null>()
    for (const transcriptPath of transcriptPaths) {
      const observedAt = now() - WINDOWS_FOREGROUND_STALENESS_MS
      const text = await io.readForeground(transcriptPath).catch(() => null)
      const sample = text === null ? null : parseWindowsForeground(text)
      answers.set(transcriptPath, sample === null ? null : { ...sample, observedAt })
    }
    return answers
  }
}
