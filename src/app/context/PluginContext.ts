import type { TaskChutePlugin } from "../../types";
import type { PathManager } from "../../managers/PathManager";
import type { RoutineAliasManager } from "../../managers/RoutineAliasManager";
import type DayStateService from "../../services/DayStateService";
import type { TaskChuteViewController } from "../taskchute/TaskChuteViewController";
import type { CommandRegistrar } from "../../commands/types";

export interface RibbonController {
  updateLabel(): void;
}

export interface LocaleCoordinatorHandle {
  dispose(): void;
}

export interface PluginContext {
  pathManager: PathManager;
  dayStateService: DayStateService;
  routineAliasManager: RoutineAliasManager;
  viewController: TaskChuteViewController;
  commandRegistrar: CommandRegistrar;
  ribbonManager: RibbonController;
  localeCoordinator: LocaleCoordinatorHandle;
}

export function createPluginContext(context: PluginContext): PluginContext {
  return context;
}

export function attachPluginContext(plugin: TaskChutePlugin, context: PluginContext): void {
  plugin.pathManager = context.pathManager;
  plugin.dayStateService = context.dayStateService;
  plugin.routineAliasManager = context.routineAliasManager;
}
