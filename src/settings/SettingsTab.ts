import { App, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TFile } from 'obsidian';
import type { TextComponent } from 'obsidian';
import { TaskChuteSettings, PathManagerLike } from '../types';
import { t } from '../i18n';

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
          const value = this.plugin.settings.specifiedFolder ?? '';
          text
            .setValue(value)
            .onChange(async (raw) => {
              const v = raw.trim();
              const validation = this.plugin.pathManager.validatePath(v);
              if (validation.valid || v === '') {
                this.plugin.settings.specifiedFolder = v || undefined;
                await this.plugin.saveSettings();
              } else {
                new Notice(
                  validation.error ||
                    t('settings.validation.invalidPath', 'Invalid path'),
                );
                text.setValue(this.plugin.settings.specifiedFolder ?? '');
              }
            });
          text.inputEl.addEventListener('blur', async () => {
            const base = this.plugin.settings.specifiedFolder?.trim();
            if (!base) return;
            try {
              await this.plugin.pathManager.ensureFolderExists(base);
            } catch {}
          });
        });
    }

  }

  private renderProjectCandidateSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.projectCandidates.heading', 'Projects'))
      .setHeading();

    new Setting(container)
      .setName(
        t('settings.storage.projectsFolderName', 'Project files location'),
      )
      .setDesc(
        t(
          'settings.storage.projectsFolderDesc',
          'Folder for project notes (optional).',
        ),
      )
      .addText((text) => {
        const value = this.plugin.settings.projectsFolder ?? '';
        text
          .setPlaceholder('')
          .setValue(value)
          .onChange(async (raw) => {
            const v = raw.trim();
            const validation = this.plugin.pathManager.validatePath(v);
            if (validation.valid || v === '') {
              this.plugin.settings.projectsFolder = v || null;
              await this.plugin.saveSettings();
            } else {
              new Notice(
                validation.error ||
                  t('settings.validation.invalidPath', 'Invalid path'),
              );
              text.setValue(this.plugin.settings.projectsFolder ?? '');
            }
          });
        text.inputEl.addEventListener('blur', async () => {
          const v = this.plugin.settings.projectsFolder?.trim();
          if (!v) return;
          try { await this.plugin.pathManager.ensureFolderExists(v); } catch {}
        });
      })
      .addExtraButton((btn) => {
        btn.setIcon('x')
          .setTooltip(t('common.clear', 'Clear'))
          .onClick(async () => {
            this.plugin.settings.projectsFolder = null;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // Enable/disable toggle
    new Setting(container)
      .setName(t('settings.projectCandidates.enable', 'Use filters'))
      .setDesc(t('settings.projectCandidates.enableDesc', 'Filter project candidates by prefixes, tags, etc.'))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.projectsFilterEnabled ?? false).onChange(async (v) => {
          this.plugin.settings.projectsFilterEnabled = v
          await this.plugin.saveSettings()
          this.display()
        })
      })

    if (!(this.plugin.settings.projectsFilterEnabled ?? false)) {
      return
    }

    const s = this.plugin.settings.projectsFilter ?? {};

    // Match mode
    new Setting(container)
      .setName(t('settings.projectCandidates.matchMode', 'Match mode'))
      .setDesc(t('settings.projectCandidates.matchModeDesc', 'How to combine rules'))
      .addDropdown((dd) => {
        const cur = s.matchMode ?? 'OR';
        dd.addOption('OR', t('settings.projectCandidates.or', 'Match any (OR)'))
          .addOption('AND', t('settings.projectCandidates.and', 'Match all (AND)'))
          .setValue(cur)
          .onChange(async (val) => {
            this.ensureProjectsFilter();
            this.plugin.settings.projectsFilter!.matchMode = val === 'AND' ? 'AND' : 'OR';
            await this.plugin.saveSettings();
          });
      });

    // Prefixes
    new Setting(container)
      .setName(t('settings.projectCandidates.prefixes', 'Filename prefixes'))
      .setDesc(t('settings.projectCandidates.prefixesDesc', 'Comma-separated. Example: Project - '))
      .addText((text) => {
        const cur = (s.prefixes ?? []).join(', ');
        text
          .setPlaceholder('Project - ')
          .setValue(cur)
          .onChange(async (raw) => {
            this.ensureProjectsFilter();
            const arr = raw
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x.length > 0);
            this.plugin.settings.projectsFilter!.prefixes = arr;
            await this.plugin.saveSettings();
          });
      });

    // Tags
    new Setting(container)
      .setName(t('settings.projectCandidates.tags', 'Tags'))
      .setDesc(t('settings.projectCandidates.tagsDesc', 'Comma-separated without #. Example: project'))
      .addText((text) => {
        const cur = (s.tags ?? []).join(', ');
        text
          .setPlaceholder('project')
          .setValue(cur)
          .onChange(async (raw) => {
            this.ensureProjectsFilter();
            const arr = raw
              .split(',')
              .map((x) => x.trim().replace(/^#/, ''))
              .filter((x) => x.length > 0);
            this.plugin.settings.projectsFilter!.tags = arr;
            await this.plugin.saveSettings();
          });
      });

    // Include subfolders
    new Setting(container)
      .setName(t('settings.projectCandidates.includeSubfolders', 'Include subfolders'))
      .addToggle((tg) => {
        tg.setValue(s.includeSubfolders ?? true).onChange(async (v) => {
          this.ensureProjectsFilter();
          this.plugin.settings.projectsFilter!.includeSubfolders = v;
          await this.plugin.saveSettings();
        });
      });

    // Limit
    new Setting(container)
      .setName(t('settings.projectCandidates.limit', 'Max candidates'))
      .addText((text) => {
        text.inputEl.type = 'number';
        text
          .setValue(String(s.limit ?? 50))
          .onChange(async (raw) => {
            this.ensureProjectsFilter();
            const n = Math.max(1, Math.min(500, Number(raw) || 50));
            this.plugin.settings.projectsFilter!.limit = n;
            await this.plugin.saveSettings();
          });
      });

    // (display rules removed per UX simplification)

    // (advanced filters removed per UX simplification)

    // (test button removed per UX simplification)
  }

  private ensureProjectsFilter(): void {
    if (!this.plugin.settings.projectsFilter) {
      this.plugin.settings.projectsFilter = {
        prefixes: ['Project - '],
        tags: ['project'],
        includeSubfolders: true,
        matchMode: 'OR',
        trimPrefixesInUI: true,
        transformName: false,
        limit: 50,
      };
    }
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
