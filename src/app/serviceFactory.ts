import { Notice } from "obsidian";

import { t } from "../i18n";
import { PathService } from "../services/PathService";
import { RoutineAliasService } from "../features/routine/services/RoutineAliasService";
import DayStatePersistenceService from "../services/DayStatePersistenceService";

import type { TaskChutePlugin } from "../types";

export interface InitializedServices {
  pathManager: PathService;
  dayStateService: DayStatePersistenceService;
  routineAliasService: RoutineAliasService;
}

export async function initializeServices(plugin: TaskChutePlugin): Promise<InitializedServices> {
  const pathManager = new PathService(plugin);
  // RoutineAliasService expects plugin.pathManager to exist when loading aliases
  plugin.pathManager = pathManager;
  const dayStateService = new DayStatePersistenceService(plugin);
  const routineAliasService = new RoutineAliasService(plugin);
  await routineAliasService.loadAliases();

  return {
    pathManager,
    dayStateService,
    routineAliasService,
  };
}

export async function ensureRequiredFolders(pathManager: PathService): Promise<void> {
  const targets: Array<{
    labelKey: string;
    fallback: string;
    getter: () => string | null;
  }> = [
    {
      labelKey: "paths.taskFolder",
      fallback: "Task folder",
      getter: () => pathManager.getTaskFolderPath(),
    },
    {
      labelKey: "paths.projectFolder",
      fallback: "Project folder",
      getter: () => pathManager.getProjectFolderPath(),
    },
    {
      labelKey: "paths.logDataFolder",
      fallback: "Log data folder",
      getter: () => pathManager.getLogDataPath(),
    },
    {
      labelKey: "paths.reviewDataFolder",
      fallback: "Review data folder",
      getter: () => pathManager.getReviewDataPath(),
    },
  ];

  for (const target of targets) {
    const label = t(target.labelKey, target.fallback);
    try {
      const path = target.getter();
      if (!path) continue; // Skip when projectFolder is unset
      await pathManager.ensureFolderExists(path);
    } catch {
      try {
        new Notice(
          t("notices.folderCreationFailed", "Failed to create {label}", { label }),
        );
      } catch {
        // Ignore if Notice is not available (e.g., in tests)
      }
    }
  }
}
