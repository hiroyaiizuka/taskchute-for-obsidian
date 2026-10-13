import { t, type TranslationKey } from "../i18n";
import type { CommandHost, ViewActions, CommandRegistrar } from "../types/Commands";

interface LocalizedCommandDefinition {
  id: string;
  nameKey: TranslationKey;
  fallback: string;
  callback: () => void | Promise<void>;
}

interface ConditionalCommandDefinition {
  id: string;
  nameKey: TranslationKey;
  fallback: string;
  checkCallback: (checking: boolean) => boolean | void;
}

type AnyCommandDefinition = LocalizedCommandDefinition | ConditionalCommandDefinition;

function isConditional(def: AnyCommandDefinition): def is ConditionalCommandDefinition {
  return "checkCallback" in def;
}

class CommandRegistrarImpl implements CommandRegistrar {
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
      {
        // No default hotkey (Obsidian's guidelines); users assign their own.
        id: "leave-comment",
        nameKey: "commands.leaveComment",
        fallback: "Leave a comment",
        callback: () => this.view.triggerLeaveComment(),
      },
      {
        // Past agent sessions (LEV-320): the AI pane is hidden while nothing
        // runs, so this is the way in when the pane is not on screen.
        id: "open-session-history",
        nameKey: "commands.openSessionHistory",
        fallback: "Open AI session history",
        callback: () => this.view.triggerOpenSessionHistory(),
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

  private hasOwnBlockingModal(): boolean {
    // Every dialog is an Obsidian `Modal` now, so `.modal` covers them all —
    // including the comment, log and AI ones that the old overlay-class check
    // never matched.
    return Array.from(activeDocument.querySelectorAll(".modal")).some(
      (modal) => !modal.classList.contains("mod-command-palette"),
    );
  }

  private hasFocusedTextInputOutsideCommandPalette(): boolean {
    const activeElement = activeDocument.activeElement;
    const HTMLElementCtor = activeDocument.defaultView?.HTMLElement ?? HTMLElement;
    if (!(activeElement instanceof HTMLElementCtor)) return false;
    if (activeElement.closest(".mod-command-palette")) return false;

    const tagName = activeElement.tagName.toLowerCase();
    if (tagName === "input" || tagName === "textarea") return true;
    return activeElement.isContentEditable;
  }

  private registerLocalizedCommand(definition: AnyCommandDefinition): void {
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
