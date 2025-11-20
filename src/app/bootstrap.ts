import { TaskChuteView } from "../features/core/views/TaskChuteView"
import { TaskChuteSettingTab } from "../settings"
import { VIEW_TYPE_TASKCHUTE, VIEW_TYPE_PROJECT_BOARD, type TaskChutePlugin } from "../types"
import { TaskChuteViewController } from "./taskchute/TaskChuteViewController"
import { createCommandRegistrar } from "../commands/registerTaskCommands"
import type { CommandRegistrar } from "../types/Commands"
import { RibbonManager } from "./ribbon/RibbonManager"
import { LocaleCoordinator } from "./locale/LocaleCoordinator"
import { ensureRequiredFolders, initializeServices } from "./serviceFactory"
import { DEFAULT_SETTINGS } from "../settings"
import type { TaskChuteSettings } from "../types"
import ProjectBoardView from "../ui/project/ProjectBoardView"
import {
  attachPluginContext,
  createPluginContext,
  type PluginContext,
} from "./context/PluginContext"
import { TaskIdManager } from "../services/TaskIdManager"

export async function prepareSettings(
  plugin: TaskChutePlugin,
): Promise<TaskChuteSettings> {
  const loaded = (await plugin.loadData()) ?? {}
  const settings = Object.assign(
    {},
    DEFAULT_SETTINGS,
    loaded,
  ) as TaskChuteSettings

  if (!settings.slotKeys) settings.slotKeys = {}
  if (typeof settings.useOrderBasedSort !== "boolean")
    settings.useOrderBasedSort = true
  if (!settings.languageOverride) settings.languageOverride = "auto"

  // Lightweight migration from legacy individual paths -> new base model
  if (!settings.locationMode) {
    try {
      const legacy = loaded as Record<string, unknown>
      const getStr = (key: string) => (typeof legacy[key] === 'string' ? (legacy[key] as string) : '')
      const task = getStr('taskFolderPath')
      const log = getStr('logDataPath')
      const review = getStr('reviewDataPath')

      const extractBase = (p: string, suffix: string) => {
        const idx = p.lastIndexOf('/' + suffix)
        if (idx < 0) return null
        const group = p.substring(0, idx) // .../TaskChute
        const gidx = group.lastIndexOf('/TaskChute')
        if (gidx < 0) return null
        const base = group.substring(0, gidx) // may be ''
        return base
      }

      const bases = [
        extractBase(task, 'Task'),
        extractBase(log, 'Log'),
        extractBase(review, 'Review'),
      ].filter((b) => b !== null) as string[]

      if (bases.length > 0) {
        // If all extracted bases are equal
        const allSame = bases.every((b) => b === bases[0])
        const base = allSame ? bases[0] : bases[0]
        if (!base) {
          settings.locationMode = 'vaultRoot'
        } else {
          settings.locationMode = 'specifiedFolder'
          settings.specifiedFolder = base
        }
      }

      // Project folder migration
      const project = getStr('projectFolderPath')
      if (project) settings.projectsFolder = project
    } catch {
      // best-effort migration only
    }
  }

  return settings
}

export async function bootstrapPlugin(
  plugin: TaskChutePlugin,
): Promise<PluginContext> {
  const { pathManager, dayStateService, routineAliasService } =
    await initializeServices(plugin)

  await ensureRequiredFolders(pathManager)

  try {
    const taskIdManager = new TaskIdManager(plugin)
    await taskIdManager.ensureAllTaskIds()
  } catch (error) {
    plugin._log?.("warn", "Failed to assign task IDs", error)
  }

  try {
    plugin.addSettingTab(new TaskChuteSettingTab(plugin.app, plugin))
  } catch (error) {
    plugin._log?.("warn", "Settings tab not available:", error)
  }

  plugin.registerView(
    VIEW_TYPE_TASKCHUTE,
    (leaf) => new TaskChuteView(leaf, plugin),
  )

  plugin.registerView(
    VIEW_TYPE_PROJECT_BOARD,
    (leaf) => new ProjectBoardView(leaf, plugin),
  )

  const viewController = new TaskChuteViewController(plugin)
  const commandRegistrar: CommandRegistrar = createCommandRegistrar(
    plugin,
    viewController,
  )
  const ribbonManager = new RibbonManager(
    (icon, title, callback) => plugin.addRibbonIcon(icon, title, callback),
    () => viewController.activateView(),
  )
  const localeCoordinator = new LocaleCoordinator({
    commandRegistrar,
    ribbonManager,
    viewController,
  })

  localeCoordinator.initialize(plugin.settings.languageOverride ?? "auto")
  ribbonManager.initialize()
  commandRegistrar.initialize()

  const context = createPluginContext({
    pathManager,
    dayStateService,
    routineAliasService,
    viewController,
    commandRegistrar,
    ribbonManager,
    localeCoordinator,
  })

  attachPluginContext(plugin, context)

  return context
}
