/**
 * AI Task - Claude Code
 *
 * Headless runs: see ClaudeCodeDispatcher. Effort is `--effort=<value>`, with
 * `ultracode` for the parallel workflow.
 */

import { ClaudeCodeDispatcher } from '../services/dispatchers/ClaudeCodeDispatcher'
import type { AiAgentDefinition } from './AiAgentDefinition'
import { windowsJoin } from './windowsPaths'

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
  execModes: [
    {
      id: 'default',
      labelKey: 'addTask.aiExecModeDefault',
      labelFallback: 'Normal',
      tokens: [],
    },
    {
      id: 'auto',
      labelKey: 'addTask.aiExecModeAuto',
      labelFallback: 'Auto mode',
      tokens: ['--permission-mode', 'auto'],
    },
    {
      id: 'skip-permissions',
      labelKey: 'addTask.aiExecModeSkipPermissions',
      labelFallback: 'Skip permissions',
      tokens: ['--dangerously-skip-permissions'],
    },
  ],
  // Verified against the local CLI and the model documentation on 2026-07-13.
  models: [
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  reasoning: {
    budgets: ['low', 'medium', 'high', 'xhigh', 'max'],
    ultraValue: 'ultracode',
    ultraLabel: { key: 'addTask.aiReasoningModeClaudeUltra', fallback: 'Ultracode (parallel workflow)' },
    modesFor: (modelId, isCustomModel) => {
      // The current Claude Code docs do not list Haiku 4.5 as supporting
      // effort. Custom remains permissive for ordinary effort because a
      // private provider/model may support it, but does not advertise
      // Ultracode.
      if (modelId === 'claude-haiku-4-5') return ['automatic']
      if (isCustomModel) return ['automatic', 'specified']
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
