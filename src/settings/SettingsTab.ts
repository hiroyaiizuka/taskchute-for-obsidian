import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
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

    this.renderStorageSection(containerEl);
    this.renderProjectCandidateSection(containerEl);
    this.renderFeaturesSection(containerEl);
  }

  private renderStorageSection(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.heading', 'Storage'))
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

    // Projects folder (independent; can be unset)
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
  }

  private renderProjectCandidateSection(container: HTMLElement): void {
    // Section heading
    new Setting(container)
      .setName(t('settings.projectCandidates.heading', 'Project candidates'))
      .setHeading();

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
