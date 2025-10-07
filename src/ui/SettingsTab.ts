import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { PathManager } from '../managers/PathManager';
import { TaskChuteSettings, PathManagerLike } from '../types';
import { LanguageOverride, setLocaleOverride, t } from '../i18n';

type PathSettingKey = 'taskFolderPath' | 'projectFolderPath' | 'logDataPath' | 'reviewDataPath';

interface PluginWithSettings extends Plugin {
  app: App;
  settings: TaskChuteSettings;
  pathManager: PathManagerLike;
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

    this.renderLanguageSection(containerEl);
    this.renderPathSection(containerEl);
  }

  private renderLanguageSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.language.name', 'Language'))
      .setDesc(t('settings.language.description', 'Override the plugin language'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', t('settings.language.options.auto', 'Follow Obsidian'))
          .addOption('en', t('settings.language.options.en', 'English'))
          .addOption('ja', t('settings.language.options.ja', 'Japanese'))
          .setValue(this.plugin.settings.languageOverride ?? 'auto')
          .onChange(async (value) => {
            const override = this.normalizeLanguageOverride(value);
            this.plugin.settings.languageOverride = override;
            await this.plugin.saveSettings();
            setLocaleOverride(override);
            this.display();
          });
      });
  }

  private normalizeLanguageOverride(value: string): LanguageOverride {
    if (value === 'auto' || value === 'en' || value === 'ja') {
      return value;
    }
    return 'auto';
  }

  private renderPathSection(container: HTMLElement): void {
    new Setting(container).setName(t('settings.heading', 'Path settings')).setHeading();

    this.createPathSetting(
      container,
      'taskFolderPath',
      PathManager.DEFAULT_PATHS.taskFolder,
      () => this.plugin.pathManager.getTaskFolderPath(),
    );

    this.createPathSetting(
      container,
      'projectFolderPath',
      PathManager.DEFAULT_PATHS.projectFolder,
      () => this.plugin.pathManager.getProjectFolderPath(),
    );

    this.createPathSetting(
      container,
      'logDataPath',
      PathManager.DEFAULT_PATHS.logData,
      () => this.plugin.pathManager.getLogDataPath(),
    );

    this.createPathSetting(
      container,
      'reviewDataPath',
      PathManager.DEFAULT_PATHS.reviewData,
      () => this.plugin.pathManager.getReviewDataPath(),
    );
  }

  private createPathSetting(
    container: HTMLElement,
    settingKey: PathSettingKey,
    placeholder: string,
    ensurePath: () => string,
  ): void {
    new Setting(container)
      .setName(this.getPathName(settingKey))
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
              new Notice(
                validation.error ||
                  t('settings.validation.invalidPath', 'Invalid path'),
              );
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

  private getPathName(settingKey: PathSettingKey): string {
    switch (settingKey) {
      case 'taskFolderPath':
        return t('settings.taskFolder.name', 'Task folder path');
      case 'projectFolderPath':
        return t('settings.projectFolder.name', 'Project folder path');
      case 'logDataPath':
        return t('settings.logDataFolder.name', 'Log data path');
      case 'reviewDataPath':
        return t('settings.reviewDataFolder.name', 'Review data path');
      default:
        return '';
    }
  }

  private getPathDescription(settingKey: PathSettingKey): string {
    switch (settingKey) {
      case 'taskFolderPath':
        return t(
          'settings.taskFolder.description',
          'Path to the folder where task files are stored',
        );
      case 'projectFolderPath':
        return t(
          'settings.projectFolder.description',
          'Path to the folder where project files are stored',
        );
      case 'logDataPath':
        return t(
          'settings.logDataFolder.description',
          'Path to the folder where execution logs are stored',
        );
      case 'reviewDataPath':
        return t(
          'settings.reviewDataFolder.description',
          'Path to the folder where review data is stored',
        );
      default:
        return '';
    }
  }

}
