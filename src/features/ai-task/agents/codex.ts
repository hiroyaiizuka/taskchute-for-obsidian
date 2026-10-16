/**
 * AI Task - Codex
 *
 * Headless runs: see CodexDispatcher. Effort is a TOML config override,
 * `--config model_reasoning_effort="<value>"`, with `ultra` for parallel
 * delegation.
 */

import { CodexDispatcher } from '../services/dispatchers/CodexDispatcher'
import { newestPerLine } from '../models/modelLines'
import type { AiAgentDefinition, AiListedModel, WindowsInstallDirs } from './AiAgentDefinition'
import { windowsJoin } from './windowsPaths'
import { createCodexSessions } from '../sessions/codexSessions'

const EFFORT_PATTERN = /^model_reasoning_effort="([^"]+)"$/u

/**
 * `codex debug models`: JSON `{ models: [{ slug, display_name, visibility,
 * supported_reasoning_levels: [{ effort }] }] }`. Only `visibility: "list"`
 * models are offered (the others are Codex's own). A debug command, so its
 * shape may change: anything unexpected throws and the built-in list stays.
 */
function parseCodexModels(output: string): AiListedModel[] {
  const parsed: unknown = JSON.parse(output.slice(output.indexOf('{')))
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) throw new Error('codex debug models: no models array')
  const listed: AiListedModel[] = []
  for (const model of models) {
    if (typeof model !== 'object' || model === null) continue
    const entry = model as Record<string, unknown>
    if (entry['visibility'] !== 'list' || typeof entry['slug'] !== 'string') continue
    const levels = Array.isArray(entry['supported_reasoning_levels'])
      ? entry['supported_reasoning_levels']
        .map((level) => (typeof level === 'object' && level !== null ? (level as Record<string, unknown>)['effort'] : null))
        .filter((effort): effort is string => typeof effort === 'string')
      : undefined
    listed.push({
      id: entry['slug'],
      label: typeof entry['display_name'] === 'string' ? entry['display_name'] : entry['slug'],
      ...(levels ? { reasoningLevels: levels } : {}),
    })
  }
  if (listed.length === 0) throw new Error('codex debug models: no listed models')
  return newestPerLine(listed, (model) => model.id)
}

/** A top-level `model = "…"` in ~/.codex/config.toml (before any [table]). */
function configuredModel(toml: string): string | null {
  for (const line of toml.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) break
    const match = /^\s*model\s*=\s*"([^"]+)"/u.exec(line)
    if (match) return match[1]
  }
  return null
}

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
  modelList: { args: ['debug', 'models'], parse: parseCodexModels },
  async defaultModel(source) {
    if (!source.home) return null
    const toml = await source.readText(source.join(source.home, '.codex', 'config.toml'))
    return toml ? configuredModel(toml) : null
  },
  reasoning: {
    budgets: ['low', 'medium', 'high', 'xhigh', 'max'],
    ultraValue: 'ultra',
    ultraLabel: { key: 'addTask.aiReasoningModeCodexUltra', fallback: 'Ultra (parallel delegation)' },
    // The CLI's own list says which models take Ultra. Without it (the
    // built-in list), Luna does not; a model the list does not know is not
    // promised Ultra.
    modesFor: (modelId, isUnlisted, levels) => {
      if (levels) return levels.includes('ultra') ? ['automatic', 'specified', 'ultra'] : ['automatic', 'specified']
      return modelId === 'gpt-5.6-luna' || isUnlisted
        ? ['automatic', 'specified']
        : ['automatic', 'specified', 'ultra']
    },
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
