import {
  WINDOWS_SHELL_ARGS,
  resolveWindowsInteractiveShell,
} from '@/features/ai-task/services/windows/WindowsInteractiveShell'

const env = {
  SystemRoot: 'C:\\Windows',
  ProgramW6432: 'C:\\Program Files',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

describe('resolveWindowsInteractiveShell', () => {
  test('opens PowerShell 7 when it is installed under Program Files', () => {
    const installed = new Set(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])
    expect(resolveWindowsInteractiveShell(env, (path) => installed.has(path))).toBe(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    )
  })

  test('finds the Microsoft Store PowerShell 7', () => {
    const installed = new Set(['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'])
    expect(resolveWindowsInteractiveShell(env, (path) => installed.has(path))).toBe(
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
    )
  })

  test('falls back to Windows PowerShell, which every Windows has', () => {
    expect(resolveWindowsInteractiveShell(env, () => false)).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('falls back to Windows PowerShell when the folders are unknown', () => {
    expect(resolveWindowsInteractiveShell({}, () => true)).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('starts PowerShell without its banner', () => {
    expect(WINDOWS_SHELL_ARGS).toEqual(['-NoLogo'])
  })
})
