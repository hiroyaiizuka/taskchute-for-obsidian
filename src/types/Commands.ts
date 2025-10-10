import type { App, Command } from "obsidian";

export interface CommandHost {
  manifest: { id: string };
  addCommand(command: Command): Command;
  app: App;
  showSettingsModal(): void;
}

export interface ViewActions {
  activateView(): Promise<void>;
  triggerDuplicateSelectedTask(): Promise<void>;
  triggerDeleteSelectedTask(): Promise<void>;
  triggerResetSelectedTask(): Promise<void>;
  triggerShowTodayTasks(): Promise<void>;
  reorganizeIdleTasks(): void;
}

export interface CommandRegistrar {
  initialize(): void;
  relocalize(): void;
}
