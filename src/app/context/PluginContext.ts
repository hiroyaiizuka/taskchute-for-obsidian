import type { TaskChutePlugin } from "../../types";
import type { PathService } from "../../services/PathService";
import type { RoutineAliasService } from "../../features/routine/services/RoutineAliasService";
import type DayStatePersistenceService from "../../services/DayStatePersistenceService";
import type { TaskChuteViewController } from "../taskchute/TaskChuteViewController";
import type { CommandRegistrar } from "../../types/Commands";
import type { ReminderSystemManager } from "../../features/reminder/services/ReminderSystemManager";
import type { AiTaskManager } from "../../features/ai-task/services/AiTaskManager";

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
  reminderManager?: ReminderSystemManager;
  /** Present only when the AI task feature is enabled on desktop */
  aiTaskManager?: AiTaskManager;
}

export function createPluginContext(context: PluginContext): PluginContext {
  return context;
}

export function attachPluginContext(plugin: TaskChutePlugin, context: PluginContext): void {
  plugin.pathManager = context.pathManager;
  plugin.dayStateService = context.dayStateService;
  plugin.routineAliasService = context.routineAliasService;
  plugin.aiTaskManager = context.aiTaskManager;
}
