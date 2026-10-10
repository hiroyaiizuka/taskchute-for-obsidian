/**
 * AI Task - Codex
 *
 * Headless runs: see CodexDispatcher. Effort is a TOML config override,
 * `--config model_reasoning_effort="<value>"`, with `ultra` for parallel
 * delegation.
 */

import { CodexDispatcher } from '../services/dispatchers/CodexDispatcher'
import type { AiAgentDefinition, WindowsInstallDirs } from './AiAgentDefinition'
import { windowsJoin } from './windowsPaths'
import { createCodexSessions } from '../sessions/codexSessions'

const EFFORT_PATTERN = /^model_reasoning_effort="([^"]+)"$/u

/** The native codex.exe that @openai/codex vendors, for this machine's architecture first. */
function nativeCandidates(npmDirectory: string, dirs: WindowsInstallDirs): string[] {
  const targets = [
    { packageName: 'codex-win32-x64', target: 'x86_64-pc-windows-msvc' },
    { packageName: 'codex-win32-arm64', target: 'aarch64-pc-windows-msvc' },
  ]
  if (dirs.architecture.includes('arm64')) targets.reverse()

  const packageRoot = windowsJoin(npmDirectory, 'node_modules', '@openai', 'codex')
  const candidates: string[] = []
  for (const target of targets) {
    const roots = [
      packageRoot,
      windowsJoin(npmDirectory, 'node_modules', '@openai', target.packageName),
      windowsJoin(packageRoot, 'node_modules', '@openai', target.packageName),
    ]
    for (const root of roots) {
      candidates.push(
        windowsJoin(root, 'vendor', target.target, 'bin', 'codex.exe'),
        windowsJoin(root, 'vendor', target.target, 'codex', 'codex.exe'),
      )
    }
  }
  return candidates
}

export const codexAgent: AiAgentDefinition = {
  id: 'codex',
  label: { key: 'addTask.aiAgentCodex', fallback: 'Codex' },
  icon: '📜',
  command: 'codex',
  pathSetting: {
    key: 'aiTaskCodexPath',
    name: { key: 'settings.aiTask.codexPathName', fallback: 'Codex CLI path (advanced fallback)' },
    desc: {
      key: 'settings.aiTask.codexPathDesc',
      fallback:
        'Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.',
    },
  },
  windows: {
    nativeExecutables: () => [],
    packageEntrypoints: (npmDirectory, dirs) => [
      ...nativeCandidates(npmDirectory, dirs),
      windowsJoin(npmDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ],
  },
  createDispatcher: (gateway) => new CodexDispatcher(gateway),
  sessions: createCodexSessions(),
  // Both flags work in the terminal and in `codex exec` (verified on 0.150.1).
  // Manual is the CLI's own default: it asks before acting.
  execModes: {
    manual: [],
    auto: ['--approve-for-me'],
    'skip-permissions': ['--dangerously-bypass-approvals-and-sandbox'],
  },
  // The former "Full auto": never asks, failures go back to the model.
  legacyExecModes: [
    { mode: 'auto', tokens: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'] },
  ],
  // Verified against the local CLI and the model documentation on 2026-07-13.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ],
  reasoning: {
    budgets: ['low', 'medium', 'high', 'xhigh', 'max'],
    ultraValue: 'ultra',
    ultraLabel: { key: 'addTask.aiReasoningModeCodexUltra', fallback: 'Ultra (parallel delegation)' },
    // Codex 0.144.1's bundled catalog advertises Ultra for Sol and Terra, but
    // not Luna. A custom provider/model is unknown, so do not promise Ultra.
    modesFor: (modelId, isCustomModel) =>
      modelId === 'gpt-5.6-luna' || isCustomModel
        ? ['automatic', 'specified']
        : ['automatic', 'specified', 'ultra'],
    // Codex parses --config values as TOML. Keep the quotes inside this argv
    // token so the effort is unambiguously a TOML string in both PTY and exec.
    effortArgs: (value) => ['--config', `model_reasoning_effort="${value}"`],
    effortAt: (args, index) => {
      const next = args[index + 1]
      if (args[index] !== '--config' || next === undefined) return null
      if (!next.startsWith('model_reasoning_effort=')) return null
      return { length: 2, value: EFFORT_PATTERN.exec(next)?.[1] }
    },
  },
}
