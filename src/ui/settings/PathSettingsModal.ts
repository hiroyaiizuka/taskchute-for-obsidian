import { Notice } from "obsidian";

import { t } from "../../i18n";
import { PathManager } from "../../managers/PathManager";
import type { TaskChuteSettings } from "../../types";

interface SettingsModalContext {
  settings: TaskChuteSettings;
  pathManager: PathManager;
  saveSettings: () => Promise<void>;
}

export function openSettingsModal(context: SettingsModalContext): void {
  const modal = document.createElement("div");
  modal.className = "task-modal-overlay";
  const modalContent = modal.createEl("div", { cls: "task-modal-content" });

  const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
  modalHeader.createEl("h3", {
    text: t("commands.openSettings", "TaskChute settings"),
  });

  const closeButton = modalHeader.createEl("button", {
    cls: "modal-close-button",
    text: "×",
    attr: { title: t("common.close", "Close") },
  });

  const form = modalContent.createEl("form", { cls: "task-form" });
  const pathSection = form.createEl("div", { cls: "settings-section" });
  pathSection.createEl("h4", {
    text: t("settings.heading", "Path settings"),
  });

  createPathSetting(pathSection, {
    label: t("settings.taskFolder.name", "Task folder path"),
    settingKey: "taskFolderPath",
    placeholder: PathManager.DEFAULT_PATHS.taskFolder,
    context,
  });

  createPathSetting(pathSection, {
    label: t("settings.projectFolder.name", "Project folder path"),
    settingKey: "projectFolderPath",
    placeholder: PathManager.DEFAULT_PATHS.projectFolder,
    context,
  });

  createPathSetting(pathSection, {
    label: t("settings.logDataFolder.name", "Log data path"),
    settingKey: "logDataPath",
    placeholder: PathManager.DEFAULT_PATHS.logData,
    context,
  });

  createPathSetting(pathSection, {
    label: t("settings.reviewDataFolder.name", "Review data path"),
    settingKey: "reviewDataPath",
    placeholder: PathManager.DEFAULT_PATHS.reviewData,
    context,
  });

  closeButton.addEventListener("click", () => {
    document.body.removeChild(modal);
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      document.body.removeChild(modal);
    }
  });

  document.body.appendChild(modal);
}

type PathSettingKey = keyof Pick<TaskChuteSettings, "taskFolderPath" | "projectFolderPath" | "logDataPath" | "reviewDataPath">;

interface PathSettingOptions {
  label: string;
  settingKey: PathSettingKey;
  placeholder: string;
  context: SettingsModalContext;
}

function createPathSetting(container: HTMLElement, options: PathSettingOptions): void {
  const group = container.createEl("div", { cls: "form-group" });
  group.createEl("label", { text: `${options.label}:`, cls: "form-label" });
  const input = group.createEl("input", {
    type: "text",
    cls: "form-input",
    attr: { placeholder: options.placeholder },
  }) as HTMLInputElement;

  input.value = (options.context.settings[options.settingKey] as string) || "";

  input.addEventListener("change", async () => {
    const value = input.value.trim();
    const validation = options.context.pathManager.validatePath(value);

    if (validation.valid || value === "") {
      (options.context.settings[options.settingKey] as string) = value;
      await options.context.saveSettings();

      try {
        switch (options.settingKey) {
          case "taskFolderPath":
            await options.context.pathManager.ensureFolderExists(options.context.pathManager.getTaskFolderPath());
            break;
          case "projectFolderPath":
            await options.context.pathManager.ensureFolderExists(options.context.pathManager.getProjectFolderPath());
            break;
          case "logDataPath":
            await options.context.pathManager.ensureFolderExists(options.context.pathManager.getLogDataPath());
            break;
          case "reviewDataPath":
            await options.context.pathManager.ensureFolderExists(options.context.pathManager.getReviewDataPath());
            break;
        }
      } catch {
        // Ignore folder creation errors
      }
    } else {
      new Notice(validation.error || t('settings.validation.invalidPath', 'Invalid path'));
      input.value = (options.context.settings[options.settingKey] as string) || "";
    }
  });
}
