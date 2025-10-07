import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { PathManager } from '../managers/PathManager';
import { TaskChuteSettings } from '../types';

type PathSettingKey = 'taskFolderPath' | 'projectFolderPath' | 'logDataPath' | 'reviewDataPath';

interface PluginWithSettings extends Plugin {
  app: App;
  settings: TaskChuteSettings;
  pathManager: PathManager;
  saveSettings(): Promise<void>;
}

export class TaskChuteSettingTab extends PluginSettingTab {
  plugin: PluginWithSettings;

  constructor(app: App, plugin: PluginWithSettings) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderPathSection(containerEl);
  }

  private renderPathSection(container: HTMLElement): void {
    new Setting(container).setName('パス設定').setHeading();

    this.createPathSetting(
      container,
      'タスクフォルダパス',
      'taskFolderPath',
      PathManager.DEFAULT_PATHS.taskFolder,
      () => this.plugin.pathManager.getTaskFolderPath(),
    );

    this.createPathSetting(
      container,
      'プロジェクトフォルダパス',
      'projectFolderPath',
      PathManager.DEFAULT_PATHS.projectFolder,
      () => this.plugin.pathManager.getProjectFolderPath(),
    );

    this.createPathSetting(
      container,
      'ログデータパス',
      'logDataPath',
      PathManager.DEFAULT_PATHS.logData,
      () => this.plugin.pathManager.getLogDataPath(),
    );

    this.createPathSetting(
      container,
      'レビューデータパス',
      'reviewDataPath',
      PathManager.DEFAULT_PATHS.reviewData,
      () => this.plugin.pathManager.getReviewDataPath(),
    );
  }

  private createPathSetting(
    container: HTMLElement,
    label: string,
    settingKey: PathSettingKey,
    placeholder: string,
    ensurePath: () => string,
  ): void {
    new Setting(container)
      .setName(label)
      .setDesc(this.getPathDescription(settingKey))
      .addText((text) => {
        const currentValue = this.plugin.settings[settingKey] ?? '';
        text
          .setPlaceholder(placeholder)
          .setValue(currentValue)
          .onChange(async (raw) => {
            const value = raw.trim();
            const validation = this.plugin.pathManager.validatePath(value);
            if (validation.valid || value === '') {
              this.plugin.settings[settingKey] = value;
              await this.plugin.saveSettings();
            } else {
              new Notice(validation.error || 'Invalid path');
              text.setValue(this.plugin.settings[settingKey] ?? '');
            }
          });

        text.inputEl.addEventListener('blur', async () => {
          try {
            await this.plugin.pathManager.ensureFolderExists(ensurePath());
          } catch {
            // Ensure is best-effort; suppress errors to avoid noisy UX.
          }
        });
      });
  }

  private getPathDescription(settingKey: PathSettingKey): string {
    switch (settingKey) {
      case 'taskFolderPath':
        return 'タスクファイルを保存するフォルダのパス';
      case 'projectFolderPath':
        return 'プロジェクトファイルを保存するフォルダのパス';
      case 'logDataPath':
        return 'タスクの実行ログを保存するフォルダのパス';
      case 'reviewDataPath':
        return 'レビュー用データを保存するフォルダのパス';
      default:
        return '';
    }
  }

}
