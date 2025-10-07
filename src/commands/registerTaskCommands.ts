import { t } from "../i18n";
import type { CommandHost, ViewActions, CommandRegistrar } from "./types";

interface LocalizedCommandDefinition {
  id: string;
  nameKey: string;
  fallback: string;
  callback: () => void | Promise<void>;
}

class CommandRegistrarImpl implements CommandRegistrar {
  private readonly localizedCommands: LocalizedCommandDefinition[] = [];

  constructor(
    private readonly host: CommandHost,
    private readonly view: ViewActions,
  ) {}

  initialize(): void {
    const definitions: LocalizedCommandDefinition[] = [
      {
        id: "open-taskchute-view",
        nameKey: "commands.openView",
        fallback: "Open TaskChute",
        callback: () => {
          void this.view.activateView();
        },
      },
      {
        id: "taskchute-settings",
        nameKey: "commands.openSettings",
        fallback: "TaskChute settings",
        callback: () => {
          this.host.showSettingsModal();
        },
      },
      {
        id: "duplicate-selected-task",
        nameKey: "commands.duplicateSelected",
        fallback: "Duplicate selected task",
        callback: () => this.view.triggerDuplicateSelectedTask(),
      },
      {
        id: "delete-selected-task",
        nameKey: "commands.deleteSelected",
        fallback: "Delete selected task",
        callback: () => this.view.triggerDeleteSelectedTask(),
      },
      {
        id: "reset-selected-task",
        nameKey: "commands.resetSelected",
        fallback: "Reset selected task",
        callback: () => this.view.triggerResetSelectedTask(),
      },
      {
        id: "show-today-tasks",
        nameKey: "commands.showToday",
        fallback: "Show today's tasks",
        callback: () => this.view.triggerShowTodayTasks(),
      },
      {
        id: "reorganize-idle-tasks",
        nameKey: "commands.reorganizeIdle",
        fallback: "Reorganize idle tasks to current slot",
        callback: () => this.view.reorganizeIdleTasks(),
      },
    ];

    definitions.forEach((definition) => this.registerLocalizedCommand(definition));
  }

  relocalize(): void {
    const baseId = this.host.manifest.id;
    for (const def of this.localizedCommands) {
      try {
        this.host.app.commands.removeCommand(`${baseId}:${def.id}`);
      } catch (error) {
        console.warn("Failed to remove command for relocalization", error);
      }
      this.registerLocalizedCommand(def);
    }
  }

  private registerLocalizedCommand(definition: LocalizedCommandDefinition): void {
    if (!this.localizedCommands.includes(definition)) {
      this.localizedCommands.push(definition);
    }
    this.host.addCommand({
      id: definition.id,
      name: t(definition.nameKey, definition.fallback),
      callback: () => {
        void definition.callback();
      },
    });
  }
}

export function createCommandRegistrar(host: CommandHost, view: ViewActions): CommandRegistrar {
  return new CommandRegistrarImpl(host, view);
}
