import type { Command } from "obsidian";

export interface CommandHost {
  addCommand(command: Command): Command;
  showSettingsModal(): void;
}

export interface ViewActions {
  activateView(): Promise<void>;
  isViewActive(): boolean;
  triggerDuplicateSelectedTask(): Promise<void>;
  triggerDeleteSelectedTask(): Promise<void>;
  triggerResetSelectedTask(): Promise<void>;
  triggerShowTodayTasks(): Promise<void>;
  reorganizeIdleTasks(): void;
  triggerLeaveComment(): Promise<void>;
}

export interface CommandRegistrar {
  initialize(): void;
}
