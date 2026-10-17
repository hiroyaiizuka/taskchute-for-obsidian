/**
 * AI Task - asking the installed CLIs about their models
 *
 * The model list comes from running the agent's CLI the same way a task run
 * finds it (BinaryLocator), with the arguments its definition gives
 * (`modelList`). What model the CLI uses by default comes from its own
 * settings files (`defaultModel`). Both are read-only.
 */

import { getAiAgent } from '../agents'
import type { AiListedModel } from '../agents/AiAgentDefinition'
import { joinSessionPath } from '../sessions/AgentSessionTypes'
import { normalizeBinaryResolution } from '../services/AiTaskManager'
import type { AiBinaryResolution } from '../services/BinaryLocator'
import type { ExecCaptureResult } from '../services/NodeProcessGateway'
import { stripAnsiSequences } from '../services/streams/AnsiStripper'
import type { AiTaskHost } from '../types'

/** A model list prints in well under this; Cursor asks its servers. */
const MODEL_LIST_TIMEOUT_MS = 20_000
/** A settings file larger than this is not one. */
const SETTINGS_MAX_BYTES = 1024 * 1024

export interface ModelListGateway {
  execCapture(
    command: string,
    args: string[],
    timeoutMs: number,
    envPatch?: Readonly<Record<string, string | undefined>>,
  ): Promise<ExecCaptureResult>
  getBaseEnv(): Record<string, string | undefined>
  getHomeDirectory(): string | undefined
  statPath(path: string): Promise<{ size: number; isDirectory: boolean } | null>
  readFileRange(path: string, position: number, length: number): Promise<string>
}

export interface ModelListBinaryLocator {
  resolve(host: AiTaskHost): Promise<AiBinaryResolution>
}

/** Runs the agent's CLI for its model list; throws when that fails or prints nothing usable. */
export function createModelListFetcher(gateway: ModelListGateway, binaryLocator: ModelListBinaryLocator) {
  return async (host: AiTaskHost): Promise<AiListedModel[]> => {
    const list = getAiAgent(host).modelList
    if (!list) return []
    const launch = normalizeBinaryResolution(await binaryLocator.resolve(host))
    const result = await gateway.execCapture(
      launch.binaryPath,
      [...(launch.binaryArgsPrefix ?? []), ...list.args],
      MODEL_LIST_TIMEOUT_MS,
      launch.binaryEnvPatch,
    )
    if (result.timedOut) throw new Error(`${host}: the model list timed out`)
    if (result.code !== 0) throw new Error(`${host}: the model list exited with ${String(result.code)}`)
    // Cursor colours its list even with NO_COLOR when run from Obsidian on Windows.
    return list.parse(stripAnsiSequences(result.stdout))
  }
}

/** Reads the model the agent's CLI uses by default, from its own settings. */
export function createDefaultModelReader(gateway: ModelListGateway) {
  return async (host: AiTaskHost): Promise<string | null> => {
    const agent = getAiAgent(host)
    if (!agent.defaultModel) return null
    return agent.defaultModel({
      home: gateway.getHomeDirectory(),
      env: gateway.getBaseEnv(),
      join: (...parts) => joinSessionPath(parts[0] ?? '', ...parts.slice(1)),
      readText: async (path) => {
        try {
          const stat = await gateway.statPath(path)
          if (!stat || stat.isDirectory || stat.size > SETTINGS_MAX_BYTES) return null
          return await gateway.readFileRange(path, 0, stat.size)
        } catch {
          return null
        }
      },
    })
  }
}
