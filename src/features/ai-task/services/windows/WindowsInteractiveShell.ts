/**
 * AI Task - the shell a + terminal opens on Windows
 *
 * macOS and Linux open the user's own login shell ($SHELL). Windows has no
 * such setting, so this follows Windows Terminal's choice: PowerShell 7
 * (pwsh) when it is installed, otherwise Windows PowerShell 5.1, which every
 * Windows 10/11 has (the ConPTY host already needs it).
 */

import { getWindowsPowerShellPath } from './ConPtyHostSource'

/** Both PowerShells: no copyright banner at the top of the terminal. */
export const WINDOWS_SHELL_ARGS: readonly string[] = ['-NoLogo']

/** Where the PowerShell 7 installers (MSI, winget, Microsoft Store) put pwsh.exe. */
function pwshCandidates(env: Readonly<Record<string, string | undefined>>): string[] {
  const candidates: string[] = []
  for (const programFiles of [env['ProgramW6432'], env['ProgramFiles']]) {
    const root = programFiles?.trim()
    if (root) candidates.push(`${root.replace(/[\\/]+$/u, '')}\\PowerShell\\7\\pwsh.exe`)
  }
  const localAppData = env['LOCALAPPDATA']?.trim()
  if (localAppData) {
    candidates.push(`${localAppData.replace(/[\\/]+$/u, '')}\\Microsoft\\WindowsApps\\pwsh.exe`)
  }
  return candidates
}

/** The PowerShell a + terminal opens: pwsh when found, else Windows PowerShell. */
export function resolveWindowsInteractiveShell(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): string {
  return pwshCandidates(env).find((path) => exists(path)) ?? getWindowsPowerShellPath(env)
}
