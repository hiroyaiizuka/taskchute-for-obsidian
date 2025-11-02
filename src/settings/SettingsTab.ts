import { App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile, TFolder, AbstractInputSuggest } from 'obsidian';
import type { TextComponent } from 'obsidian';
import { TaskChuteSettings, PathManagerLike } from '../types';
import { t } from '../i18n';
import { FolderPathFieldController } from './folderPathFieldController';

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

    let templatePathInput: TextComponent | null = null;

    const pathSetting = new Setting(container)
      .setName(t('settings.reviewTemplate.pathName', 'Template file'))
      .setDesc(
        t(
          'settings.reviewTemplate.pathDesc',
          'Path to the markdown file used as the review template.',
        ),
      );

    pathSetting.addText((text) => {
      templatePathInput = text;
      const current = this.plugin.settings.reviewTemplatePath ?? '';
      text
        .setPlaceholder('TaskChute/Templates/DailyReview.md')
        .setValue(current)
        .onChange(async (raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            this.plugin.settings.reviewTemplatePath = null;
            await this.plugin.saveSettings();
            return;
          }

          const validation = this.plugin.pathManager.validatePath(trimmed);
          if (!validation.valid) {
            new Notice(
              validation.error ||
                t('settings.validation.invalidPath', 'Invalid path'),
            );
            text.setValue(this.plugin.settings.reviewTemplatePath ?? '');
            return;
          }

          this.plugin.settings.reviewTemplatePath = trimmed;
          await this.plugin.saveSettings();
        });

      text.inputEl.addEventListener('blur', () => {
        const path = this.plugin.settings.reviewTemplatePath?.trim();
        if (!path) return;
        const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(abstract instanceof TFile)) {
          this.notifyMissingTemplate(path);
        }
      });
    });

    pathSetting.addExtraButton((btn) => {
      btn
        .setIcon('magnifying-glass')
        .setTooltip(
          t(
            'settings.reviewTemplate.pick',
            'Select file from vault',
          ),
        )
        .onClick(() => {
          const modal = new ReviewTemplateSuggestModal(this.app, (file) => {
            const normalized = file.path;
            this.plugin.settings.reviewTemplatePath = normalized;
            void this.plugin.saveSettings();
            templatePathInput?.setValue(normalized);
          });
          modal.open();
        });
    });

    pathSetting.addExtraButton((btn) => {
      btn
        .setIcon('x')
        .setTooltip(t('common.clear', 'Clear'))
        .onClick(async () => {
          this.plugin.settings.reviewTemplatePath = null;
          await this.plugin.saveSettings();
          templatePathInput?.setValue('');
        });
    });
  }

  private notifyMissingTemplate(path: string): void {
    new Notice(
      t(
        'notices.reviewTemplateMissing',
        'Review template file was not found: {path}',
        { path },
      ),
    );
  }

  private notifyMissingProjectTemplate(path: string): void {
    new Notice(
      t(
        'notices.projectTemplateMissing',
        'Project template file was not found: {path}',
        { path },
      ),
    );
  }

  private folderExists(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFolder;
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
        text
          .setPlaceholder('Project - ')
          .setValue(value)
          .onChange(async (raw) => {
            this.plugin.settings.projectTitlePrefix = raw
            await this.plugin.saveSettings()
          })
      })

    let projectFolderInput: TextComponent | null = null;
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
        projectFolderInput = text;
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
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('magnifying-glass')
          .setTooltip(
            t(
              'settings.projectCandidates.folderPick',
              'Select folder from vault',
            ),
          )
          .onClick(() => {
            if (projectFolderInput) {
              projectFolderInput.inputEl.focus();
            }
            if (projectFolderSuggest) {
              projectFolderSuggest.setValue(projectFolderInput?.getValue() ?? '');
              projectFolderSuggest.open();
            } else {
              const modal = new ProjectFolderSuggestModal(this.app, (folder) => {
                const normalized = folder.path;
                void projectFolderController?.handleSuggestionSelect(normalized);
              });
              modal.open();
            }
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('x')
          .setTooltip(t('common.clear', 'Clear'))
          .onClick(async () => {
            if (projectFolderController) {
              await projectFolderController.handleSuggestionSelect('');
            } else {
              this.plugin.settings.projectsFolder = null;
              await this.plugin.saveSettings();
              projectFolderInput?.setValue('');
            }
          });
      });

    let templateInput: TextComponent | null = null;
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
        templateInput = text;
        const value = this.plugin.settings.projectTemplatePath ?? '';
        text
          .setPlaceholder('Projects/Template.md')
          .setValue(value)
          .onChange(async (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) {
              this.plugin.settings.projectTemplatePath = null;
              await this.plugin.saveSettings();
              return;
            }
            const validation = this.plugin.pathManager.validatePath(trimmed);
            if (!validation.valid) {
              new Notice(
                validation.error ||
                  t('settings.validation.invalidPath', 'Invalid path'),
              );
              text.setValue(this.plugin.settings.projectTemplatePath ?? '');
              return;
            }
            this.plugin.settings.projectTemplatePath = trimmed;
            await this.plugin.saveSettings();
          });

        text.inputEl.addEventListener('blur', () => {
          const path = this.plugin.settings.projectTemplatePath?.trim();
          if (!path) return;
          const file = this.plugin.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) {
            this.notifyMissingProjectTemplate(path);
          }
        });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('magnifying-glass')
          .setTooltip(
            t(
              'settings.projectCandidates.templatePick',
              'Select template file from vault',
            ),
          )
          .onClick(() => {
            const modal = new ProjectTemplateSuggestModal(
              this.app,
              this.plugin.settings.projectsFolder ?? undefined,
              (file) => {
                const normalized = file.path;
                this.plugin.settings.projectTemplatePath = normalized;
                void this.plugin.saveSettings();
                templateInput?.setValue(normalized);
              },
            );
            modal.open();
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('x')
          .setTooltip(t('common.clear', 'Clear'))
          .onClick(async () => {
            this.plugin.settings.projectTemplatePath = null;
            await this.plugin.saveSettings();
            templateInput?.setValue('');
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

class ReviewTemplateSuggestModal extends SuggestModal<TFile> {
  private readonly onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(
      t(
        'settings.reviewTemplate.suggestPlaceholder',
        'Type to search review template files',
      ),
    );
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.toLowerCase().includes(lower));
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    const target = el as HTMLElement & { setText?: (value: string) => void };
    if (typeof target.setText === 'function') {
      target.setText(file.path);
    } else {
      target.textContent = file.path;
    }
  }

  onChooseSuggestion(file: TFile): void {
    this.onChoose(file);
    this.close();
  }
}

class ProjectFolderSuggestModal extends SuggestModal<TFolder> {
  private readonly onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(
      t(
        'settings.projectCandidates.folderSuggestPlaceholder',
        'Type to search folders',
      ),
    );
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path.toLowerCase().includes(lower));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  onChooseSuggestion(folder: TFolder): void {
    this.onChoose(folder);
    this.close();
  }
}

class ProjectTemplateSuggestModal extends SuggestModal<TFile> {
  private readonly baseFolder?: string;
  private readonly onChoose: (file: TFile) => void;

  constructor(app: App, baseFolder: string | undefined, onChoose: (file: TFile) => void) {
    super(app);
    this.baseFolder = baseFolder;
    this.onChoose = onChoose;
    this.setPlaceholder(
      t(
        'settings.projectCandidates.templateSuggestPlaceholder',
        'Type to search project templates',
      ),
    );
  }

  getSuggestions(query: string): TFile[] {
    const lower = query.toLowerCase();
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.toLowerCase().includes(lower));
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  onChooseSuggestion(file: TFile): void {
    this.onChoose(file);
    this.close();
  }
}

class FolderPathSuggest extends AbstractInputSuggest<TFolder> {
  private readonly onChoose: (folderPath: string) => void;

  constructor(app: App, inputEl: HTMLInputElement, onChoose: (folderPath: string) => void) {
    super(app, inputEl);
    this.onChoose = onChoose;
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
