/**
 * AI Task - Claude Code
 *
 * Headless runs: see ClaudeCodeDispatcher. Effort is `--effort=<value>`, with
 * `ultracode` for the parallel workflow.
 */

import { ClaudeCodeDispatcher } from '../services/dispatchers/ClaudeCodeDispatcher'
import type { AiAgentDefinition } from './AiAgentDefinition'
import { windowsJoin } from './windowsPaths'
import { claudeSessions } from '../sessions/claudeSessions'

const EFFORT_PREFIX = '--effort='

export const claudeAgent: AiAgentDefinition = {
  id: 'claude',
  // Reference parity: main-agents.ts gives Claude Code the 👑 icon.
  label: { key: 'addTask.aiAgentClaude', fallback: 'Claude Code' },
  icon: '👑',
  command: 'claude',
  pathSetting: {
    key: 'aiTaskClaudePath',
    name: { key: 'settings.aiTask.claudePathName', fallback: 'Claude CLI path (advanced fallback)' },
    desc: {
      key: 'settings.aiTask.claudePathDesc',
      fallback:
        'Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.',
    },
  },
  windows: {
    nativeExecutables: (dirs) => [
      windowsJoin(dirs.userProfile, '.claude', 'local', 'claude.exe'),
      windowsJoin(dirs.localAppData, 'Claude', 'claude.exe'),
      windowsJoin(dirs.programFiles, 'Claude', 'claude.exe'),
      windowsJoin(dirs.programFilesX86, 'Claude', 'claude.exe'),
      windowsJoin(dirs.userProfile, '.local', 'bin', 'claude.exe'),
      windowsJoin(dirs.userProfile, '.volta', 'bin', 'claude.exe'),
      windowsJoin(dirs.userProfile, 'scoop', 'shims', 'claude.exe'),
      windowsJoin(dirs.localAppData, 'pnpm', 'claude.exe'),
    ],
    packageEntrypoints: (npmDirectory) => [
      windowsJoin(npmDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs'),
      windowsJoin(npmDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ],
  },
  createDispatcher: (gateway) => new ClaudeCodeDispatcher(gateway),
  sessions: claudeSessions,
  // `--permission-mode manual` is spelled out so a manual task asks even when
  // the user's Claude settings default to another mode (2.1.295 lists
  // manual, auto, acceptEdits, bypassPermissions, dontAsk, plan).
  execModes: {
    manual: ['--permission-mode', 'manual'],
    auto: ['--permission-mode', 'auto'],
    'skip-permissions': ['--dangerously-skip-permissions'],
  },
  // Verified against the local CLI and the model documentation on 2026-07-13.
  // Claude Code has no command that lists models. Its aliases always mean the
  // newest version of each model (`--model opus`), so these never go stale.
  models: [
    { id: 'fable', label: 'Claude Fable' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'haiku', label: 'Claude Haiku' },
  ],
  // ~/.claude/settings.json `model`, or ANTHROPIC_MODEL. Without either,
  // Claude Code picks by the account's plan, which only it knows.
  async defaultModel(source) {
    const fromEnv = source.env['ANTHROPIC_MODEL']?.trim()
    if (fromEnv) return fromEnv
    if (!source.home) return null
    const text = await source.readText(source.join(source.home, '.claude', 'settings.json'))
    try {
      const settings: unknown = text ? JSON.parse(text) : null
      const model = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['model'] : null
      return typeof model === 'string' && model.trim() ? model.trim() : null
    } catch {
      return null
    }
  },
  reasoning: {
    budgets: ['low', 'medium', 'high', 'xhigh', 'max'],
    ultraValue: 'ultracode',
    ultraLabel: { key: 'addTask.aiReasoningModeClaudeUltra', fallback: 'Ultracode (parallel workflow)' },
    modesFor: (modelId, isUnlisted) => {
      // The Claude Code docs do not list Haiku as supporting effort. A model
      // the list does not know (an older task's) keeps ordinary effort but is
      // not promised Ultracode.
      if (modelId === 'haiku' || modelId.startsWith('claude-haiku')) return ['automatic']
      if (isUnlisted) return ['automatic', 'specified']
      return ['automatic', 'specified', 'ultra']
    },
    effortArgs: (value) => [`${EFFORT_PREFIX}${value}`],
    effortAt: (args, index) => {
      const token = args[index]
      return token.startsWith(EFFORT_PREFIX)
        ? { length: 1, value: token.slice(EFFORT_PREFIX.length) }
        : null
    },
  },
}
