/**
 * AI Task - PTY platform predicate
 *
 * The single place that answers "can this OS host an embedded terminal?".
 * macOS/Linux use `script(1)`, Windows the ConPTY host; whether a Windows
 * machine can actually run it is decided by NodeProcessGateway's probe.
 *
 * Deliberately a standalone module with no imports: NodeProcessGateway owns
 * the runtime behaviour but pulls in Node builtins, while the settings tab
 * needs the same answer on every platform (including mobile, where requiring
 * a Node builtin is forbidden — see "gate every Node builtin behind
 * Platform.isDesktop").
 */

import { Platform } from 'obsidian'

export function isPtyPlatformSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

/**
 * The same answer for callers that hold no `process` — the settings tab runs
 * on mobile too, where reading `process.platform` is not allowed. Kept beside
 * the string predicate so the supported set is stated once.
 */
export function isTerminalModeSupportedHere(): boolean {
  if (!Platform.isDesktop) return false
  return (
    Platform.isMacOS === true ||
    Platform.isLinux === true ||
    Platform.isWin === true
  )
}
