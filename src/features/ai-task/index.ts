/**
 * AI Task - feature entry point
 *
 * createAiTaskManager wires the whole feature (Node gateway, binary locator,
 * dispatchers, log writer, run manager) behind the shared gate in
 * ./availability. When any gate fails it returns undefined and nothing
 * AI-related is instantiated, keeping mobile, unlicensed and opted-out vaults
 * completely inert.
 */

import type { App } from 'obsidian'
import type { PathManagerLike, TaskChutePluginLike, TaskChuteSettings } from '../../types'
import { evaluateAiTaskAvailability } from './availability'
import type { AiRunMode, AiTaskHost } from './types'
import { AiTaskLogWriter } from './services/AiTaskLogWriter'
import {
  AiTaskManager,
  type AiTaskManagerDeps,
} from './services/AiTaskManager'
import { BinaryLocator } from './services/BinaryLocator'
import { NodeProcessGateway } from './services/NodeProcessGateway'
import type { AiDispatcher } from './services/dispatchers/Dispatcher'
import { ClaudeCodeDispatcher } from './services/dispatchers/ClaudeCodeDispatcher'
import { CodexDispatcher } from './services/dispatchers/CodexDispatcher'
import {
  TerminalDispatcher,
  type AiTerminalDispatcher,
} from './services/dispatchers/TerminalDispatcher'
import { BrokerTerminalDispatcher } from './services/dispatchers/BrokerTerminalDispatcher'
import { TerminalSessionBrokerClient } from './services/TerminalSessionBroker'
import { WorkspaceFileService } from './services/WorkspaceFileService'
import { RecipeService } from '../recipe/services/RecipeService'
import { RecipeContextProvider } from '../recipe/services/RecipeContextProvider'
import { AiRunSessionStateStore } from './services/AiRunSessionStateStore'
import {
  acquireRetainedAiTaskManager,
  AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY,
  createAiTaskTerminalRendererLeaseIdentity,
  getAiTaskRuntimeLeaseGeneration,
  retainAiTaskManager,
} from './services/AiTaskRuntimeLease'

export interface AiTaskPluginLike {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  /** Ownership token used to reject stale old-plugin unload callbacks. */
  aiTaskRuntimeLeaseGeneration?: number
  /**
   * Entitlement gate. Structural on purpose: the AI task feature only needs to
   * ask whether the license is active, and tests fake it with a single method.
   */
  licenseManager?: { isActive: () => boolean }
  _log?: (level?: string, ...args: unknown[]) => void
}

const DEFAULT_LOG_RETENTION_DAYS = 30

function getVaultBrokerIdentity(app: App): string | undefined {
  const adapter = app.vault.adapter as unknown as
    | { getBasePath?: () => unknown }
    | undefined
  const basePath = adapter?.getBasePath?.()
  if (typeof basePath !== 'string' || basePath.trim().length === 0) {
    return undefined
  }
  return `taskchute-plus:${basePath}`
}

/**
 * Create the AiTaskManager for this plugin instance, or undefined when the
 * feature is disabled, the platform is not desktop, or the license is not
 * active. Returning undefined keeps unlicensed vaults completely inert rather
 * than building a runtime that would then have to refuse every run.
 */
export function createAiTaskManager(plugin: AiTaskPluginLike): AiTaskManager | undefined {
  plugin.aiTaskRuntimeLeaseGeneration = undefined
  const availability = evaluateAiTaskAvailability(plugin)
  if (!availability.available) {
    if (availability.reason === 'unlicensed') {
      plugin._log?.('debug', '[AiTask] No active license; feature disabled')
    } else if (availability.reason === 'unsupported-paths') {
      plugin._log?.('warn', '[AiTask] Path manager lacks AI log paths; feature disabled')
    }
    return undefined
  }

  // Runtime-validated by the availability gate; the cast makes the optional
  // path methods required.
  const logPathManager = plugin.pathManager as PathManagerLike & {
    getAiLogsPath: () => string
    getAiLogsMonthPath: (yearMonth: string) => string
  }

  const log = (level: 'warn' | 'error' | 'debug', ...args: unknown[]): void => {
    plugin._log?.(level, ...args)
  }

  const gateway = new NodeProcessGateway()
  const binaryLocator = new BinaryLocator(gateway, () => ({
    aiTaskClaudePath: plugin.settings.aiTaskClaudePath,
    aiTaskCodexPath: plugin.settings.aiTaskCodexPath,
  }))
  const dispatchers: Record<AiTaskHost, AiDispatcher> = {
    claude: new ClaudeCodeDispatcher(gateway),
    codex: new CodexDispatcher(gateway),
  }
  const logWriter = new AiTaskLogWriter({
    app: plugin.app,
    pathManager: {
      getAiLogsPath: () => logPathManager.getAiLogsPath(),
      getAiLogsMonthPath: (yearMonth: string) => logPathManager.getAiLogsMonthPath(yearMonth),
      ensureFolderExists: (path: string) => logPathManager.ensureFolderExists(path),
    },
    getRetentionDays: () => {
      const value = plugin.settings.aiTaskLogRetentionDays
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : DEFAULT_LOG_RETENTION_DAYS
    },
    log,
  })
  const recipeService = new RecipeService(
    plugin as unknown as TaskChutePluginLike,
  )
  const localStorageApp = plugin.app as unknown as {
    loadLocalStorage?: (key: string) => unknown
    saveLocalStorage?: (key: string, value: unknown) => void
  }
  const sessionState =
    typeof localStorageApp.loadLocalStorage === 'function' &&
    typeof localStorageApp.saveLocalStorage === 'function'
      ? new AiRunSessionStateStore(
          {
            loadLocalStorage: (key) => localStorageApp.loadLocalStorage?.(key),
            saveLocalStorage: (key, value) => {
              localStorageApp.saveLocalStorage?.(key, value)
            },
          },
          { log },
        )
      : undefined
  const rendererLeaseGenerationStore =
    typeof localStorageApp.loadLocalStorage === 'function' &&
    typeof localStorageApp.saveLocalStorage === 'function'
      ? {
          load: () =>
            localStorageApp.loadLocalStorage?.(
              AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY,
            ),
          save: (generation: number) => {
            localStorageApp.saveLocalStorage?.(
              AI_TASK_TERMINAL_RENDERER_LEASE_GENERATION_STORAGE_KEY,
              generation,
            )
          },
        }
      : undefined
  const brokerIdentity = getVaultBrokerIdentity(plugin.app)
  // Reserve before constructing the client. AiTaskManager's constructor can
  // synchronously restore terminal sessions; no temporary random owner may
  // ever reach the broker before the runtime slot is retained.
  const initialRendererLease =
    createAiTaskTerminalRendererLeaseIdentity(
      rendererLeaseGenerationStore,
    )
  const terminalDispatcher: AiTerminalDispatcher =
    gateway.isPtySupported() && brokerIdentity !== undefined
      ? new BrokerTerminalDispatcher(
          gateway,
          new TerminalSessionBrokerClient({
            identity: brokerIdentity,
            rendererLeaseToken: initialRendererLease.token,
            rendererLeaseOwnerId: initialRendererLease.ownerId,
            rendererLeaseGeneration: initialRendererLease.generation,
            getEnv: () => gateway.getBaseEnv(),
            log: (level, ...args) => log(level, ...args),
          }),
        )
      : new TerminalDispatcher(gateway)

  const deps: AiTaskManagerDeps = {
    app: plugin.app,
    dispatchers,
    binaryLocator,
    logWriter,
    terminal: {
      dispatcher: terminalDispatcher,
      isSupported: () => gateway.isPtySupported(),
      makeTempFilePath: (prefix: string) => gateway.makeTempFilePath(prefix),
      readAndDeleteFile: (path: string) => gateway.readAndDeleteFile(path),
      // Plain shell sessions (U2 split panels) spawn the user's login shell.
      getShellPath: () => gateway.getShellPath(),
    },
    workspaceFiles: new WorkspaceFileService(gateway),
    recipeContextProvider: new RecipeContextProvider({
      isFeatureEnabled: () => plugin.settings.recipeFeatureEnabled === true,
      getRecipeFolderPath: () => recipeService.getRecipeFolderPath(),
      loadRecipe: (path) => recipeService.loadRecipe(path),
    }),
    // Terminal is the default experience. Without a bundled Windows ConPTY
    // native runtime, win32 uses the cross-platform conversation pipeline.
    getRunMode: (): AiRunMode =>
      plugin.settings.aiTaskRunMode === 'headless' ? 'headless' : 'terminal',
    sessionState,
    log,
  }

  const retained = acquireRetainedAiTaskManager(
    plugin.app,
    deps,
    undefined,
    undefined,
    rendererLeaseGenerationStore,
  )
  if (retained) {
    plugin.aiTaskRuntimeLeaseGeneration =
      getAiTaskRuntimeLeaseGeneration(retained)
    log('debug', '[AiTask] Adopted live runtime after plugin reload')
    return retained
  }

  try {
    // AiTaskManager restores persisted sessions in its constructor. Assign
    // the final slot identity first, otherwise that early attach can publish
    // a random temporary owner after retainAiTaskManager activates the real
    // owner and roll the broker back to stale renderer state.
    void Promise.resolve(
      terminalDispatcher.setRendererLeaseToken?.(
        initialRendererLease.token,
        initialRendererLease.ownerId,
        initialRendererLease.generation,
      ),
    ).catch((error) => {
      log(
        'warn',
        '[AiTask] Initial terminal renderer lease activation failed',
        error,
      )
    })
  } catch (error) {
    log(
      'warn',
      '[AiTask] Initial terminal renderer lease assignment failed',
      error,
    )
  }
  const manager = new AiTaskManager(deps)
  retainAiTaskManager(
    plugin.app,
    manager,
    undefined,
    initialRendererLease,
    rendererLeaseGenerationStore,
  )
  plugin.aiTaskRuntimeLeaseGeneration =
    getAiTaskRuntimeLeaseGeneration(manager)
  return manager
}
