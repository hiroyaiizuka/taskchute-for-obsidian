import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, AbstractInputSuggest } from 'obsidian';
import { TaskChuteSettings, PathManagerLike } from '../types';
import { t } from '../i18n';
import { FolderPathFieldController } from './folderPathFieldController';
import { FilePathFieldController } from './filePathFieldController';
import { FilePathSuggest } from './filePathSuggest';

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
    containerEl.classList.add('taskchute-settings-pane');

    this.renderStorageSection(containerEl);
    this.renderReviewTemplateSection(containerEl);
    this.renderProjectCandidateSection(containerEl);
    this.renderFeaturesSection(containerEl);
  }

  private renderReviewTemplateSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.reviewTemplate.heading', 'Review'))
      .setHeading();

    const pattern = this.plugin.settings.reviewFileNamePattern ?? 'Daily - {{date}}.md';
    const prefix = pattern.endsWith('{{date}}.md')
      ? pattern.slice(0, -'{{date}}.md'.length)
      : pattern;

    new Setting(container)
      .setName(t('settings.reviewTemplate.prefixName', 'File name prefix'))
      .setDesc(t('settings.reviewTemplate.prefixDesc', 'Example: Daily - '))
      .addText((text) => {
        text
          .setPlaceholder('Daily - ')
          .setValue(prefix)
          .onChange(async (raw) => {
            const base = raw.trim() || 'Daily - ';
            this.plugin.settings.reviewFileNamePattern = `${base}{{date}}.md`;
            await this.plugin.saveSettings();
          });
      });

    const pathSetting = new Setting(container)
      .setName(t('settings.reviewTemplate.pathName', 'Template file'))
      .setDesc(
        t(
          'settings.reviewTemplate.pathDesc',
          'Path to the markdown file used as the review template.',
        ),
      );

    let reviewTemplateController: FilePathFieldController | null = null;
    let reviewTemplateSuggest: FilePathSuggest | null = null;

    pathSetting.addText((text) => {
      reviewTemplateController = new FilePathFieldController({
        text,
        getStoredValue: () => this.plugin.settings.reviewTemplatePath ?? null,
        setStoredValue: (next) => {
          if (!next) {
            this.plugin.settings.reviewTemplatePath = null;
          } else {
            this.plugin.settings.reviewTemplatePath = next;
          }
        },
        saveSettings: () => this.plugin.saveSettings(),
        validatePath: (path) => this.plugin.pathManager.validatePath(path),
        fileExists: (path) => this.fileExists(path),
        makeMissingNotice: (path) =>
          t(
            'notices.reviewTemplateMissing',
            'Review template file was not found: {path}',
            { path },
          ),
        notice: (message) => new Notice(message),
        emptyValue: null,
      });

      reviewTemplateSuggest = new FilePathSuggest(
        this.app,
        text.inputEl,
        async (filePath) => {
          await reviewTemplateController?.handleSuggestionSelect(filePath);
        },
      );

      text.setValue(this.plugin.settings.reviewTemplatePath ?? '').onChange(async (raw) => {
        await reviewTemplateController?.handleInputChange(raw);
      });

      text.inputEl.addEventListener('focus', () => {
        reviewTemplateSuggest?.setValue(text.getValue());
        reviewTemplateSuggest?.open();
      });

      text.inputEl.addEventListener('blur', () => {
        void reviewTemplateController?.handleBlur();
      });
    });

    // Extra buttons removed per new design (no magnifier or clear icon).
  }
  private folderExists(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFolder;
  }

  private fileExists(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFile;
  }

  private renderStorageSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.heading', 'TaskChute file paths'))
      .setHeading();

    // Base location dropdown
    new Setting(container)
      .setName(
        t(
          'settings.storage.baseLocationName',
          'Default storage location',
        ),
      )
      .setDesc(
        t(
          'settings.storage.baseLocationDesc',
          'Save Task/Log/Review under the selected base.',
        ),
      )
      .addDropdown((dd) => {
        const current = this.plugin.settings.locationMode ?? 'vaultRoot';
        dd.addOption(
          'vaultRoot',
          t(
            'settings.storage.baseOptions.vaultRoot',
            'Vault root (TaskChute/...)',
          ),
        );
        dd.addOption(
          'specifiedFolder',
          t(
            'settings.storage.baseOptions.specifiedFolder',
            'Below specified folder',
          ),
        );
        dd.setValue(current)
          .onChange(async (val) => {
            const mode = val === 'specifiedFolder' ? 'specifiedFolder' : 'vaultRoot';
            this.plugin.settings.locationMode = mode;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // Specified folder (render only when mode === specifiedFolder)
    const isSpecified = (this.plugin.settings.locationMode ?? 'vaultRoot') === 'specifiedFolder';
    if (isSpecified) {
      new Setting(container)
        .setName(
          t('settings.storage.specifiedFolderName', 'Specified folder'),
        )
        .setDesc(
          t(
            'settings.storage.specifiedFolderDesc',
            'TaskChute/... will be created under this folder.',
          ),
        )
        .addText((text) => {
          const controller = new FolderPathFieldController({
            text,
            getStoredValue: () => this.plugin.settings.specifiedFolder,
            setStoredValue: (next) => {
              this.plugin.settings.specifiedFolder = next ?? undefined;
            },
            saveSettings: () => this.plugin.saveSettings(),
            validatePath: (path) => this.plugin.pathManager.validatePath(path),
            folderExists: (path) => this.folderExists(path),
            makeMissingNotice: (path) =>
              t(
                'settings.validation.missingFolder',
                'Folder was not found: {path}',
                { path },
              ),
            notice: (message) => new Notice(message),
            emptyValue: undefined,
          });

          text
            .setValue(this.plugin.settings.specifiedFolder ?? '')
            .onChange(async (raw) => {
              await controller.handleInputChange(raw);
            });

          const suggest = new FolderPathSuggest(
            this.app,
            text.inputEl,
            async (folderPath) => {
              await controller.handleSuggestionSelect(folderPath);
            },
          );

          text.inputEl.addEventListener('focus', () => {
            suggest.setValue(text.getValue());
            suggest.open();
          });

          text.inputEl.addEventListener('blur', () => {
            void controller.handleBlur();
          });
        });
    }

  }

  private renderProjectCandidateSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.projectCandidates.heading', 'Projects'))
      .setHeading();

    new Setting(container)
      .setName(t('settings.projectCandidates.titlePrefixName', 'File name prefix'))
      .setDesc(
        t(
          'settings.projectCandidates.titlePrefixDesc',
          'Applied to project titles when creating new notes.',
        ),
      )
      .addText((text) => {
        const value = this.plugin.settings.projectTitlePrefix ?? 'Project - '
        text.setValue(value).onChange(async (raw) => {
          this.plugin.settings.projectTitlePrefix = raw
          await this.plugin.saveSettings()
        })
      })

    let projectFolderController: FolderPathFieldController | null = null;
    let projectFolderSuggest: FolderPathSuggest | null = null;
    const folderSetting = new Setting(container)
      .setName(
        t('settings.projectCandidates.folderName', 'Project files location'),
      )
      .setDesc(
        t(
          'settings.projectCandidates.folderDesc',
          'Folder where project notes will be saved.',
        ),
      );

    folderSetting
      .addText((text) => {
        projectFolderController = new FolderPathFieldController({
          text,
          getStoredValue: () => this.plugin.settings.projectsFolder ?? undefined,
          setStoredValue: (next) => {
            if (next === null || next === undefined || next === '') {
              this.plugin.settings.projectsFolder = null;
            } else {
              this.plugin.settings.projectsFolder = next;
            }
          },
          saveSettings: () => this.plugin.saveSettings(),
          validatePath: (path) => this.plugin.pathManager.validatePath(path),
          folderExists: (path) => this.folderExists(path),
          makeMissingNotice: (path) =>
            t(
              'settings.validation.missingFolder',
              'Folder was not found: {path}',
              { path },
            ),
          notice: (message) => new Notice(message),
          emptyValue: null,
        });

        text
          .setValue(this.plugin.settings.projectsFolder ?? '')
          .onChange(async (raw) => {
            await projectFolderController?.handleInputChange(raw);
          });

        projectFolderSuggest = new FolderPathSuggest(
          this.app,
          text.inputEl,
          async (folderPath) => {
            await projectFolderController?.handleSuggestionSelect(folderPath);
          },
        );

        text.inputEl.addEventListener('focus', () => {
          projectFolderSuggest?.setValue(text.getValue());
          projectFolderSuggest?.open();
        });

        text.inputEl.addEventListener('blur', () => {
          void projectFolderController?.handleBlur();
        });
      });

    let projectTemplateController: FilePathFieldController | null = null;
    let projectTemplateSuggest: FilePathSuggest | null = null;
    const templateSetting = new Setting(container)
      .setName(
        t('settings.projectCandidates.templateName', 'Template file'),
      )
      .setDesc(
        t(
          'settings.projectCandidates.templateDesc',
          'Optional markdown template applied when creating new projects.',
        ),
      );

    templateSetting
      .addText((text) => {
        projectTemplateController = new FilePathFieldController({
          text,
          getStoredValue: () => this.plugin.settings.projectTemplatePath ?? null,
          setStoredValue: (next) => {
            if (!next) {
              this.plugin.settings.projectTemplatePath = null;
            } else {
              this.plugin.settings.projectTemplatePath = next;
            }
          },
          saveSettings: () => this.plugin.saveSettings(),
          validatePath: (path) => this.plugin.pathManager.validatePath(path),
          fileExists: (path) => this.fileExists(path),
          makeMissingNotice: (path) =>
            t(
              'notices.projectTemplateMissing',
              'Project template file was not found: {path}',
              { path },
            ),
          notice: (message) => new Notice(message),
          emptyValue: null,
        });

        projectTemplateSuggest = new FilePathSuggest(
          this.app,
          text.inputEl,
          async (filePath) => {
            await projectTemplateController?.handleSuggestionSelect(filePath);
          },
        );

        const value = this.plugin.settings.projectTemplatePath ?? '';
        text.setValue(value).onChange(async (raw) => {
          await projectTemplateController?.handleInputChange(raw);
        });

        text.inputEl.addEventListener('blur', () => {
          void projectTemplateController?.handleBlur();
        });

        text.inputEl.addEventListener('focus', () => {
          projectTemplateSuggest?.setValue(text.getValue());
          projectTemplateSuggest?.open();
        });
      });
  }

  private renderFeaturesSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.features.heading', 'External tools'))
      .setHeading();

    new Setting(container)
      .setName(t('settings.features.robotButton', 'Show Terminal button'))
      .setDesc(t('settings.features.robotButtonDesc', 'Enable AI integration via Terminal (requires Terminal plugin).'))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.aiRobotButtonEnabled ?? false).onChange(async (v) => {
          this.plugin.settings.aiRobotButtonEnabled = v
          await this.plugin.saveSettings()
        })
      })
  }
}

class FolderPathSuggest extends AbstractInputSuggest<TFolder> {
  private readonly onChoose: (folderPath: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onChoose: (folderPath: string) => void) {
    super(app, inputEl);
    this.onChoose = onChoose;
  }

  setValue(value: string): void {
    this.inputEl.value = value;
  }

  protected getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path.toLowerCase().includes(lower));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    void this.onChoose(folder.path);
    this.close();
  }
}
