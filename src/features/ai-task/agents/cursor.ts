/**
 * AI Task - Cursor (the Cursor Agent CLI)
 *
 * Headless runs: see CursorDispatcher. The installer puts both `agent` and
 * `cursor-agent` on PATH; `cursor-agent` is the name looked up, since
 * `agent` is too generic to be sure it is Cursor's.
 *
 * On Windows the installer lays out `%LOCALAPPDATA%\cursor-agent\` with
 * `cursor-agent.cmd`/`.ps1` launchers and `versions\<version>\` folders that
 * each carry their own `node.exe` and `index.js`. The launchers pick the
 * newest version; the plugin does the same and runs node.exe directly,
 * because a `.cmd` shim cannot be stopped reliably (verified on 2026.10.01).
 */

import { CursorDispatcher } from '../services/dispatchers/CursorDispatcher'
import { newestPerLine, onePerFamily, withoutVariantWords } from '../models/modelLines'
import type { AiAgentDefinition, AiListedModel } from './AiAgentDefinition'
import { windowsJoin } from './windowsPaths'
import { cursorSessions } from '../sessions/cursorSessions'

/**
 * `cursor-agent models`: a heading, then "<id> - <name>" per line. Every
 * model comes at several efforts and speeds, and in several versions; one row
 * per model, newest version only. "auto" is what the CLI's default already is.
 */
function parseCursorModels(output: string): AiListedModel[] {
  const rows: AiListedModel[] = []
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.replace(/\u200b|\u200c|\u200d|\ufeff/gu, '').trim()
    const at = line.indexOf(' - ')
    if (at <= 0) continue
    const id = line.slice(0, at).trim()
    if (!/^[A-Za-z0-9._:/-]+$/u.test(id) || id === 'auto') continue
    rows.push({ id, label: withoutVariantWords(line.slice(at + 3).trim()) || id })
  }
  if (rows.length === 0) throw new Error('cursor-agent models: no models')
  return newestPerLine(onePerFamily(rows, (row) => row.id), (row) => row.id)
}

/** `2026.10.01-e373342`, or the newer `2026.10.01-12-30-45-e373342` with a build time. */
const VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/u

function versionKey(name: string): string | null {
  const match = VERSION_PATTERN.exec(name)
  if (!match) return null
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  return [year, month.padStart(2, '0'), day.padStart(2, '0'), hour, minute, second].join('')
}

export function newestCursorVersionsFirst(names: readonly string[]): string[] {
  return names
    .map((name) => ({ name, key: versionKey(name) }))
    .filter((entry): entry is { name: string; key: string } => entry.key !== null)
    .sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : 0))
    .map((entry) => entry.name)
}

export const cursorAgent: AiAgentDefinition = {
  id: 'cursor',
  label: { key: 'addTask.aiAgentCursor', fallback: 'Cursor' },
  icon: '🖱️',
  command: 'cursor-agent',
  pathSetting: {
    key: 'aiTaskCursorPath',
    name: { key: 'settings.aiTask.cursorPathName', fallback: 'Cursor CLI path (advanced fallback)' },
    desc: {
      key: 'settings.aiTask.cursorPathDesc',
      fallback:
        'Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.',
    },
  },
  windows: {
    nativeExecutables: () => [],
    packageEntrypoints: () => [],
    versionedInstall: {
      roots: (dirs) => [windowsJoin(dirs.localAppData, 'cursor-agent')],
      versionsFolder: (root) => windowsJoin(root, 'versions'),
      newestFirst: newestCursorVersionsFirst,
      launch: (folder) => ({
        executable: windowsJoin(folder, 'node.exe'),
        entrypoint: windowsJoin(folder, 'index.js'),
      }),
    },
  },
  createDispatcher: (gateway) => new CursorDispatcher(gateway),
  sessions: cursorSessions,
  // Without it, a folder not trusted yet makes the terminal ask first and a
  // headless run exit 1; works in both, not only with -p (verified on 2026.10.01).
  trustFolderArgs: ['--trust'],
  // Verified on 2026.10.01, headless: with no flag, shell commands are
  // refused; `--sandbox disabled` runs the commands on the user's Cursor
  // allowlist (`permissions.allow` in ~/.cursor/cli-config.json) on their
  // own and refuses the rest, the same on every OS; `--force` ("Run
  // Everything") allows anything not explicitly denied. `--sandbox enabled`
  // is not used: its sandbox needs macOS or Linux, and on Windows a headless
  // run exits ("Sandbox requires macOS or Linux").
  execModes: {
    manual: [],
    auto: ['--sandbox', 'disabled'],
    'skip-permissions': ['--force'],
  },
  autoModeNote: {
    key: 'addTask.aiAutoNoteCursor',
    fallback:
      "In auto mode Cursor runs only the commands on its allowlist (permissions.allow in ~/.cursor/cli-config.json) without asking. Other commands ask first in the terminal and are not run in conversation mode.",
  },
  legacyExecModes: [{ mode: 'skip-permissions', tokens: ['--yolo'] }],
  // Cursor's models change often, so none are built in: the list comes from
  // `cursor-agent models` (asks the account; a few seconds).
  models: [],
  modelList: { args: ['models'], parse: parseCursorModels },
  // ~/.cursor/cli-config.json: the model Cursor uses when none is given.
  async defaultModel(source) {
    if (!source.home) return null
    const text = await source.readText(source.join(source.home, '.cursor', 'cli-config.json'))
    try {
      const config: unknown = text ? JSON.parse(text) : null
      const model = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['model'] : null
      if (typeof model !== 'object' || model === null) return null
      const name = (model as Record<string, unknown>)['displayName'] ?? (model as Record<string, unknown>)['modelId']
      return typeof name === 'string' && name.trim() ? name.trim() : null
    } catch {
      return null
    }
  },
  reasoning: null,
}
