import type { TaskChutePlugin } from "../../types";
import type { PathService } from "../../services/PathService";
import type { RoutineAliasService } from "../../features/routine/services/RoutineAliasService";
import type DayStatePersistenceService from "../../services/DayStatePersistenceService";
import type { TaskChuteViewController } from "../taskchute/TaskChuteViewController";
import type { CommandRegistrar } from "../../types/Commands";

export interface RibbonController {
  updateLabel(): void;
}

export interface LocaleCoordinatorHandle {
  dispose(): void;
}

export interface PluginContext {
  pathManager: PathService;
  dayStateService: DayStatePersistenceService;
  routineAliasService: RoutineAliasService;
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
  plugin.routineAliasService = context.routineAliasService;
}
