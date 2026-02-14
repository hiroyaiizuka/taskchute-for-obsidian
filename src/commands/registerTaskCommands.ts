import { t } from "../i18n";
import type { CommandHost, ViewActions, CommandRegistrar } from "../types/Commands";

interface LocalizedCommandDefinition {
  id: string;
  nameKey: string;
  fallback: string;
  callback: () => void | Promise<void>;
}

interface ConditionalCommandDefinition {
  id: string;
  nameKey: string;
  fallback: string;
  checkCallback: (checking: boolean) => boolean | void;
}

type AnyCommandDefinition = LocalizedCommandDefinition | ConditionalCommandDefinition;

function isConditional(def: AnyCommandDefinition): def is ConditionalCommandDefinition {
  return "checkCallback" in def;
}

class CommandRegistrarImpl implements CommandRegistrar {
  private readonly allCommands: AnyCommandDefinition[] = [];

  constructor(
    private readonly host: CommandHost,
    private readonly view: ViewActions,
  ) {}

  initialize(): void {
    const globalCommands: LocalizedCommandDefinition[] = [
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

    const selectionCommands: ConditionalCommandDefinition[] = [
      {
        id: "duplicate-selected-task",
        nameKey: "commands.duplicateSelected",
        fallback: "Duplicate selected task",
        checkCallback: (checking) => {
          if (checking) return this.view.isViewActive();
          if (!this.view.isViewActive()) return false;
          if (this.hasOwnBlockingModal()) return false;
          if (this.hasFocusedTextInputOutsideCommandPalette()) return false;
          void this.view.triggerDuplicateSelectedTask();
          return true;
        },
      },
      {
        id: "delete-selected-task",
        nameKey: "commands.deleteSelected",
        fallback: "Delete selected task",
        checkCallback: (checking) => {
          if (checking) return this.view.isViewActive();
          if (!this.view.isViewActive()) return false;
          if (this.hasOwnBlockingModal()) return false;
          if (this.hasFocusedTextInputOutsideCommandPalette()) return false;
          void this.view.triggerDeleteSelectedTask();
          return true;
        },
      },
      {
        id: "reset-selected-task",
        nameKey: "commands.resetSelected",
        fallback: "Reset selected task",
        checkCallback: (checking) => {
          if (checking) return this.view.isViewActive();
          if (!this.view.isViewActive()) return false;
          if (this.hasOwnBlockingModal()) return false;
          if (this.hasFocusedTextInputOutsideCommandPalette()) return false;
          void this.view.triggerResetSelectedTask();
          return true;
        },
      },
    ];

    const definitions: AnyCommandDefinition[] = [...globalCommands, ...selectionCommands];
    definitions.forEach((definition) => this.registerLocalizedCommand(definition));
  }

  relocalize(): void {
    const baseId = this.host.manifest.id;
    for (const def of this.allCommands) {
      try {
        this.host.app.commands.removeCommand(`${baseId}:${def.id}`);
      } catch (error) {
        console.warn("Failed to remove command for relocalization", error);
      }
      this.registerLocalizedCommand(def);
    }
  }

  private hasOwnBlockingModal(): boolean {
    if (document.querySelector(".task-modal-overlay")) return true;
    return Array.from(document.querySelectorAll(".modal")).some(
      (modal) => !modal.classList.contains("mod-command-palette"),
    );
  }

  private hasFocusedTextInputOutsideCommandPalette(): boolean {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    if (activeElement.closest(".mod-command-palette")) return false;

    const tagName = activeElement.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea") return true;
    return activeElement.isContentEditable;
  }

  private registerLocalizedCommand(definition: AnyCommandDefinition): void {
    if (!this.allCommands.includes(definition)) {
      this.allCommands.push(definition);
    }
    if (isConditional(definition)) {
      this.host.addCommand({
        id: definition.id,
        name: t(definition.nameKey, definition.fallback),
        checkCallback: definition.checkCallback,
      });
    } else {
      this.host.addCommand({
        id: definition.id,
        name: t(definition.nameKey, definition.fallback),
        callback: () => {
          void definition.callback();
        },
      });
    }
  }
}

export function createCommandRegistrar(host: CommandHost, view: ViewActions): CommandRegistrar {
  return new CommandRegistrarImpl(host, view);
}
