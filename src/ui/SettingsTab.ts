import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import { PathManager } from '../managers/PathManager';
import { TaskChuteSettings } from '../types';

interface PluginWithSettings {
  app: App;
  settings: TaskChuteSettings;
  pathManager: PathManager;
  saveSettings(): Promise<void>;
}

export class TaskChuteSettingTab extends PluginSettingTab {
  plugin: PluginWithSettings;

  constructor(app: App, plugin: PluginWithSettings) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
              new Notice(validation.error || "Invalid path");
              text.setValue(this.plugin.settings.taskFolderPath || "");
            }
          });

        text.inputEl.addEventListener("blur", async () => {
          try {
            await this.plugin.pathManager.ensureFolderExists(
              this.plugin.pathManager.getTaskFolderPath()
            );
          } catch (error) {
            // Silently handle folder creation errors
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
              new Notice(validation.error || "Invalid path");
              text.setValue(this.plugin.settings.projectFolderPath || "");
            }
          });

        text.inputEl.addEventListener("blur", async () => {
          try {
            await this.plugin.pathManager.ensureFolderExists(
              this.plugin.pathManager.getProjectFolderPath()
            );
          } catch (error) {
            // Silently handle folder creation errors
          }
        });
      });

    // Log data path
    new Setting(containerEl)
      .setName("ログデータパス")
      .setDesc("タスクの実行ログを保存するフォルダのパス")
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
              new Notice(validation.error || "Invalid path");
              text.setValue(this.plugin.settings.logDataPath || "");
            }
          });

        text.inputEl.addEventListener("blur", async () => {
          try {
            await this.plugin.pathManager.ensureFolderExists(
              this.plugin.pathManager.getLogDataPath()
            );
          } catch (error) {
            // Silently handle folder creation errors
          }
        });
      });

    // Review data path
    new Setting(containerEl)
      .setName("レビューデータパス")
      .setDesc("デイリーレビューファイルを保存するフォルダのパス")
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
              new Notice(validation.error || "Invalid path");
              text.setValue(this.plugin.settings.reviewDataPath || "");
            }
          });

        text.inputEl.addEventListener("blur", async () => {
          try {
            await this.plugin.pathManager.ensureFolderExists(
              this.plugin.pathManager.getReviewDataPath()
            );
          } catch (error) {
            // Silently handle folder creation errors
          }
        });
      });
  }
}