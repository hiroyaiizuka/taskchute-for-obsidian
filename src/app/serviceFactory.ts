import { Notice } from "obsidian";

import { t } from "../i18n";
import { PathManager } from "../managers/PathManager";
import { RoutineAliasManager } from "../managers/RoutineAliasManager";
import DayStateService from "../services/DayStateService";

import type { TaskChutePlugin } from "../types";

export interface InitializedServices {
  pathManager: PathManager;
  dayStateService: DayStateService;
  routineAliasManager: RoutineAliasManager;
}

export async function initializeServices(plugin: TaskChutePlugin): Promise<InitializedServices> {
  const pathManager = new PathManager(plugin);
  // RoutineAliasManager expects plugin.pathManager to exist when loading aliases
  plugin.pathManager = pathManager;
  const dayStateService = new DayStateService(plugin);
  const routineAliasManager = new RoutineAliasManager(plugin);
  await routineAliasManager.loadAliases();

  return {
    pathManager,
    dayStateService,
    routineAliasManager,
  };
}

export async function ensureRequiredFolders(pathManager: PathManager): Promise<void> {
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
