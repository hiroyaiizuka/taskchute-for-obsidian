import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  Setting
} from 'obsidian';

import { TaskChuteSettings } from './types';
import { DEFAULT_SETTINGS } from './settings';
import { PathManager } from './managers/PathManager';
import { RoutineAliasManager } from './managers/RoutineAliasManager';
import { TaskChuteView } from './views/TaskChuteView';

const VIEW_TYPE_TASKCHUTE = "taskchute-view";

// PluginSettingTab implementation
class TaskChuteSettingTab extends PluginSettingTab {
  plugin: TaskChutePlusPlugin;

  constructor(app: any, plugin: TaskChutePlusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Path settings section
    new Setting(containerEl).setName("パス設定").setHeading();

    // Task folder path
    new Setting(containerEl)
      .setName("タスクフォルダパス")
      .setDesc("タスクファイルを保存するフォルダのパス")
      .addText((text) => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.taskFolder)
          .setValue(this.plugin.settings.taskFolderPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value);
            if (validation.valid || value === "") {
              this.plugin.settings.taskFolderPath = value;
              await this.plugin.saveSettings();
            } else {
              new Notice(validation.error!);
              text.setValue(this.plugin.settings.taskFolderPath || "");
            }
          });

        text.inputEl.addEventListener("blur", async () => {
          if (this.plugin.settings.taskFolderPath || !this.plugin.settings.taskFolderPath) {
            try {
              await this.plugin.pathManager.ensureFolderExists(
                this.plugin.pathManager.getTaskFolderPath()
              );
            } catch (error) {
              // Failed to create task folder
            }
          }
        });
      });

    // Project folder path
    new Setting(containerEl)
      .setName("プロジェクトフォルダパス")
      .setDesc("プロジェクトファイルを保存するフォルダのパス")
      .addText((text) => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.projectFolder)
          .setValue(this.plugin.settings.projectFolderPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value);
            if (validation.valid || value === "") {
              this.plugin.settings.projectFolderPath = value;
              await this.plugin.saveSettings();
            } else {
              new Notice(validation.error!);
              text.setValue(this.plugin.settings.projectFolderPath || "");
            }
          });
      });

    // Log data path
    new Setting(containerEl)
      .setName("ログデータパス")
      .setDesc("ログデータを保存するフォルダのパス")
      .addText((text) => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.logData)
          .setValue(this.plugin.settings.logDataPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value);
            if (validation.valid || value === "") {
              this.plugin.settings.logDataPath = value;
              await this.plugin.saveSettings();
            } else {
              new Notice(validation.error!);
              text.setValue(this.plugin.settings.logDataPath || "");
            }
          });
      });

    // Review data path
    new Setting(containerEl)
      .setName("レビューデータパス")
      .setDesc("レビューデータを保存するフォルダのパス")
      .addText((text) => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.reviewData)
          .setValue(this.plugin.settings.reviewDataPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value);
            if (validation.valid || value === "") {
              this.plugin.settings.reviewDataPath = value;
              await this.plugin.saveSettings();
            } else {
              new Notice(validation.error!);
              text.setValue(this.plugin.settings.reviewDataPath || "");
            }
          });
      });

    // Visual effects settings
    new Setting(containerEl).setName("視覚効果設定").setHeading();

    new Setting(containerEl)
      .setName("効果音を有効化")
      .setDesc("タスク完了時に効果音を再生する")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSound)
          .onChange(async (value) => {
            this.plugin.settings.enableSound = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("花火エフェクトを有効化")
      .setDesc("タスク完了時に花火エフェクトを表示する")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableFireworks)
          .onChange(async (value) => {
            this.plugin.settings.enableFireworks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("紙吹雪エフェクトを有効化")
      .setDesc("タスク完了時に紙吹雪エフェクトを表示する")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableConfetti)
          .onChange(async (value) => {
            this.plugin.settings.enableConfetti = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

export default class TaskChutePlusPlugin extends Plugin {
  settings!: TaskChuteSettings;
  pathManager!: PathManager;
  routineAliasManager!: RoutineAliasManager;
  globalTimerInterval?: NodeJS.Timer | null;

  // Simple logger/notification wrapper
  _log(level?: string, ...args: any[]): void {
    try {
      (console as any)[level || 'log']?.(...args);
    } catch (_) {}
  }

  _notify(message: string, timeout?: number): void {
    try {
      new Notice(message, timeout);
    } catch (_) {
      this._log('warn', '[Notice]', message);
    }
  }

  async onload(): Promise<void> {
    // Load settings with defaults
    const loaded = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    // Initialize PathManager
    this.pathManager = new PathManager(this);

    // Initialize RoutineAliasManager
    this.routineAliasManager = new RoutineAliasManager(this);
    await this.routineAliasManager.loadAliases();

    // Create required folders on first startup
    await this.ensureRequiredFolders();

    // Add settings tab if available
    try {
      this.addSettingTab(new TaskChuteSettingTab(this.app, this));
    } catch (error) {
      this._log('warn', 'Settings tab not available:', error);
    }

    // Register view type
    this.registerView(
      VIEW_TYPE_TASKCHUTE,
      (leaf) => new TaskChuteView(leaf, this)
    );

    // Add ribbon icon
    this.addRibbonIcon("checkmark", "TaskChuteを開く", () => {
      this.activateTaskChuteView();
    });

    // Register commands
    this.registerCommands();
  }

  async onunload(): Promise<void> {
    // Clear timer intervals
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval);
      this.globalTimerInterval = null;
    }

    // Clear boundary check timeout
    const view = this.getTaskChuteView();
    if (view && view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout);
      view.boundaryCheckTimeout = null;
    }

    // Clean up views
    this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE).forEach(leaf => {
      if (leaf.view && leaf.view.onunload) {
        leaf.view.onunload();
      }
    });

    // Clean up old localStorage data (optional)
    try {
      const today = new Date();
      const cutoffDate = new Date(today);
      cutoffDate.setDate(today.getDate() - 30); // Remove data older than 30 days

      const keysToCheck = Object.keys(localStorage);
      keysToCheck.forEach((key) => {
        const dateMatch = key.match(/taskchute-.*-(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const keyDate = new Date(dateMatch[1]);
          if (keyDate < cutoffDate) {
            localStorage.removeItem(key);
          }
        }
      });
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  private registerCommands(): void {
    // Main TaskChute command
    this.addCommand({
      id: "open-taskchute-view",
      name: "TaskChuteを開く",
      callback: () => {
        this.activateTaskChuteView();
      },
    });

    // Settings command
    this.addCommand({
      id: "taskchute-settings",
      name: "TaskChute設定",
      callback: () => {
        this.showSettingsModal();
      },
    });

    // Task manipulation commands
    this.addCommand({
      id: "duplicate-selected-task",
      name: "選択されたタスクを複製",
      // ホットキーはデフォルトで設定しない
      callback: async () => {
        const view = this.getTaskChuteView();
        if (view && view.selectedTaskInstance) {
          await view.duplicateInstance(view.selectedTaskInstance);
          view.clearTaskSelection();
        } else {
          new Notice("タスクが選択されていません");
        }
      },
    });

    this.addCommand({
      id: "delete-selected-task",
      name: "選択されたタスクを削除",
      // ホットキーはデフォルトで設定しない
      callback: () => {
        const view = this.getTaskChuteView();
        if (view && view.selectedTaskInstance) {
          view.deleteSelectedTask();
        } else {
          new Notice("タスクが選択されていません");
        }
      },
    });

    this.addCommand({
      id: "reset-selected-task",
      name: "選択されたタスクを未実行に戻す",
      callback: () => {
        const view = this.getTaskChuteView();
        if (view && view.selectedTaskInstance) {
          if (view.selectedTaskInstance.state !== "idle") {
            view.resetTaskToIdle(view.selectedTaskInstance);
          } else {
            new Notice("既に未実行状態です");
          }
        } else {
          new Notice("タスクが選択されていません");
        }
      },
    });

    // Today's tasks command with hotkey
    this.addCommand({
      id: "show-today-tasks",
      name: "今日のタスクを表示",
      description: "Show today's tasks",
      hotkeys: [
        {
          modifiers: ["Alt"],
          key: "t",
        },
      ],
      callback: () => {
        const view = this.getTaskChuteView();
        if (view) {
          view.showTodayTasks();
        } else {
          new Notice("TaskChuteビューが開かれていません");
        }
      },
    });

    // Reorganize idle tasks command
    this.addCommand({
      id: 'reorganize-idle-tasks',
      name: '未実行タスクを現在の時間帯に整理',
      callback: () => {
        const view = this.getTaskChuteView();
        if (view) {
          view.reorganizeIdleTasks();
        } else {
          new Notice("TaskChuteビューが開かれていません");
        }
      },
    });
  }

  async ensureRequiredFolders(): Promise<void> {
    const targets: [string, () => string][] = [
      ["タスクフォルダ", () => this.pathManager.getTaskFolderPath()],
      ["プロジェクトフォルダ", () => this.pathManager.getProjectFolderPath()],
      ["ログデータフォルダ", () => this.pathManager.getLogDataPath()],
      ["レビューデータフォルダ", () => this.pathManager.getReviewDataPath()],
    ];

    for (const [label, getter] of targets) {
      try {
        const path = getter();
        await this.pathManager.ensureFolderExists(path);
      } catch (error) {
        try {
          new Notice(`${label}の作成に失敗しました`);
        } catch (_) {
          // Ignore if Notice is not available (e.g., in tests)
        }
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getTaskChuteView(): TaskChuteView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)[0];
    if (leaf && leaf.view instanceof TaskChuteView) {
      return leaf.view;
    }
    return null;
  }

  async activateTaskChuteView(): Promise<void> {
    const { workspace } = this.app;
    // Open in a new tab in the main pane
    const leaf = workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_TASKCHUTE,
      active: true,
    });
  }

  showSettingsModal(): void {
    // Create modal overlay
    const modal = document.createElement("div");
    modal.className = "task-modal-overlay";
    const modalContent = modal.createEl("div", { cls: "task-modal-content" });

    // Modal header
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
    modalHeader.createEl("h3", { text: "TaskChute設定" });

    // Close button
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    });

    // Form container
    const form = modalContent.createEl("form", { cls: "task-form" });

    // Path settings section
    const pathSection = form.createEl("div", { cls: "settings-section" });
    pathSection.createEl("h4", { text: "パス設定" });

    // Task folder path
    this.createPathSetting(
      pathSection,
      "タスクフォルダパス",
      "taskFolderPath",
      PathManager.DEFAULT_PATHS.taskFolder
    );

    // Project folder path
    this.createPathSetting(
      pathSection,
      "プロジェクトフォルダパス", 
      "projectFolderPath",
      PathManager.DEFAULT_PATHS.projectFolder
    );

    // Log data path
    this.createPathSetting(
      pathSection,
      "ログデータパス",
      "logDataPath", 
      PathManager.DEFAULT_PATHS.logData
    );

    // Review data path
    this.createPathSetting(
      pathSection,
      "レビューデータパス",
      "reviewDataPath",
      PathManager.DEFAULT_PATHS.reviewData
    );

    // Effects settings section
    const effectsSection = form.createEl("div", { cls: "settings-section" });
    effectsSection.createEl("h4", { text: "視覚効果設定" });

    this.createToggleSetting(effectsSection, "効果音を有効化", "enableSound");
    this.createToggleSetting(effectsSection, "花火エフェクトを有効化", "enableFireworks");
    this.createToggleSetting(effectsSection, "紙吹雪エフェクトを有効化", "enableConfetti");

    // Event listeners
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal);
      }
    });

    // Add to DOM
    document.body.appendChild(modal);
  }

  private createPathSetting(container: HTMLElement, label: string, settingKey: keyof TaskChuteSettings, placeholder: string): void {
    const group = container.createEl("div", { cls: "form-group" });
    group.createEl("label", { text: label + ":", cls: "form-label" });
    const input = group.createEl("input", {
      type: "text",
      cls: "form-input",
      attr: { placeholder }
    }) as HTMLInputElement;

    input.value = (this.settings[settingKey] as string) || "";

    input.addEventListener("change", async () => {
      const value = input.value.trim();
      const validation = this.pathManager.validatePath(value);
      
      if (validation.valid || value === "") {
        (this.settings[settingKey] as string) = value;
        await this.saveSettings();
        
        // Try to create folder
        try {
          if (settingKey === "taskFolderPath") {
            await this.pathManager.ensureFolderExists(this.pathManager.getTaskFolderPath());
          } else if (settingKey === "projectFolderPath") {
            await this.pathManager.ensureFolderExists(this.pathManager.getProjectFolderPath());
          } else if (settingKey === "logDataPath") {
            await this.pathManager.ensureFolderExists(this.pathManager.getLogDataPath());
          } else if (settingKey === "reviewDataPath") {
            await this.pathManager.ensureFolderExists(this.pathManager.getReviewDataPath());
          }
        } catch (error) {
          // Ignore folder creation errors
        }
      } else {
        new Notice(validation.error!);
        input.value = (this.settings[settingKey] as string) || "";
      }
    });
  }

  private createToggleSetting(container: HTMLElement, label: string, settingKey: keyof TaskChuteSettings): void {
    const group = container.createEl("div", { cls: "form-group checkbox-group" });
    const checkbox = group.createEl("input", {
      type: "checkbox",
      cls: "form-checkbox"
    }) as HTMLInputElement;
    
    group.createEl("label", { text: label, cls: "form-label" });

    checkbox.checked = this.settings[settingKey] as boolean;

    checkbox.addEventListener("change", async () => {
      (this.settings[settingKey] as boolean) = checkbox.checked;
      await this.saveSettings();
    });
  }
}