import { TaskChuteView } from "../views/TaskChuteView"
import { TaskChuteSettingTab } from "../ui/SettingsTab"
import { VIEW_TYPE_TASKCHUTE, type TaskChutePlugin } from "../types"
import { TaskChuteViewController } from "../views/controllers/TaskChuteViewController"
import { createCommandRegistrar } from "../commands/registerTaskCommands"
import type { CommandRegistrar } from "../commands/types"
import { RibbonManager } from "./ribbon/RibbonManager"
import { LocaleCoordinator } from "./locale/LocaleCoordinator"
import { ensureRequiredFolders, initializeServices } from "./serviceFactory"
import { DEFAULT_SETTINGS } from "../settings"
import type { TaskChuteSettings } from "../types"
import {
  attachPluginContext,
  createPluginContext,
  type PluginContext,
} from "./context/PluginContext"

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

  return settings
}

export async function bootstrapPlugin(
  plugin: TaskChutePlugin,
): Promise<PluginContext> {
  const { pathManager, dayStateService, routineAliasManager } =
    await initializeServices(plugin)

  await ensureRequiredFolders(pathManager)

  try {
    plugin.addSettingTab(new TaskChuteSettingTab(plugin.app, plugin))
  } catch (error) {
    plugin._log?.("warn", "Settings tab not available:", error)
  }

  plugin.registerView(
    VIEW_TYPE_TASKCHUTE,
    (leaf) => new TaskChuteView(leaf, plugin),
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
    routineAliasManager,
    viewController,
    commandRegistrar,
    ribbonManager,
    localeCoordinator,
  })

  attachPluginContext(plugin, context)

  return context
}
