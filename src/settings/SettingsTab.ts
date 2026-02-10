import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  AbstractInputSuggest,
} from "obsidian"
import { TaskChuteSettings, SectionBoundary, PathManagerLike, VIEW_TYPE_TASKCHUTE } from "../types"
import { t } from "../i18n"
import { TERMINAL_NAME } from "../constants"
import { FolderPathFieldController } from "./folderPathFieldController"
import { FilePathFieldController } from "./filePathFieldController"
import { FilePathSuggest } from "./filePathSuggest"
import { SectionConfigService } from "../services/SectionConfigService"
import { showConfirmModal } from "../ui/modals/ConfirmModal"

interface PluginWithSettings extends Plugin {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  saveSettings(): Promise<void>
}

export class TaskChuteSettingTab extends PluginSettingTab {
  plugin: PluginWithSettings

  constructor(app: App, plugin: PluginWithSettings) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.classList.add("taskchute-settings-pane")

    this.renderStorageSection(containerEl)
    this.renderLogBackupSection(containerEl)
    this.renderReviewTemplateSection(containerEl)
    this.renderProjectCandidateSection(containerEl)
    this.renderAdvancedSection(containerEl)
  }

  private setHeadingIfSupported(setting: Setting): void {
    const maybeHeading = setting as Setting & { setHeading?: () => Setting }
    if (typeof maybeHeading.setHeading === "function") {
      maybeHeading.setHeading()
    }
  }

  private renderLogBackupSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.logBackup.heading", "Log"))
    this.setHeadingIfSupported(heading)

    const intervalSetting = new Setting(container)
      .setName(t("settings.logBackup.intervalName", "Backup interval (hours)"))
      .setDesc(
        t(
          "settings.logBackup.intervalDesc",
          "Only create JSON backups if the previous backup is older than this many hours.",
        ),
      )
      .addText((text) => {
        text.inputEl.type = "number"
        text.inputEl.min = "1"
        text.inputEl.step = "1"
        const current = this.plugin.settings.backupIntervalHours ?? 2
        text
          .setPlaceholder("2")
          .setValue(String(current))
          .onChange(async (raw) => {
            const parsed = Number(raw)
            const normalized = Number.isFinite(parsed)
              ? Math.max(1, Math.round(parsed))
              : 2
            this.plugin.settings.backupIntervalHours = normalized
            await this.plugin.saveSettings()
          })
      })

    intervalSetting.controlEl?.addClass("taskchute-number-input")

    const retentionSetting = new Setting(container)
      .setName(t("settings.logBackup.retentionName", "Backup retention (days)"))
      .setDesc(
        t(
          "settings.logBackup.retentionDesc",
          "Backups older than this window are deleted automatically during reconciliation.",
        ),
      )
      .addText((text) => {
        text.inputEl.type = "number"
        text.inputEl.min = "1"
        text.inputEl.step = "1"
        const current = this.plugin.settings.backupRetentionDays ?? 30
        text
          .setPlaceholder("30")
          .setValue(String(current))
          .onChange(async (raw) => {
            const parsed = Number(raw)
            const normalized = Number.isFinite(parsed)
              ? Math.max(1, Math.round(parsed))
              : 30
            this.plugin.settings.backupRetentionDays = normalized
            await this.plugin.saveSettings()
          })
      })

    retentionSetting.controlEl?.addClass("taskchute-number-input")
  }

  private renderReviewTemplateSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.reviewTemplate.heading", "Review"))
    this.setHeadingIfSupported(heading)

    const pattern =
      this.plugin.settings.reviewFileNamePattern ?? "Review - {{date}}.md"
    const normalizedPattern =
      pattern.trim().length === 0 ? "Review - {{date}}.md" : pattern
    const prefix = normalizedPattern.endsWith("{{date}}.md")
      ? normalizedPattern.slice(0, -"{{date}}.md".length)
      : normalizedPattern

    new Setting(container)
      .setName(t("settings.reviewTemplate.prefixName", "File name prefix"))
      .setDesc(t("settings.reviewTemplate.prefixDesc", "Example: Review - "))
      .addText((text) => {
        text
          .setPlaceholder("Review - ")
          .setValue(prefix)
          .onChange(async (raw) => {
            const base = raw.trim().length === 0 ? "Review - " : raw
            this.plugin.settings.reviewFileNamePattern = `${base}{{date}}.md`
            await this.plugin.saveSettings()
          })
      })

    const pathSetting = new Setting(container)
      .setName(t("settings.reviewTemplate.pathName", "Template file"))
      .setDesc(
        t(
          "settings.reviewTemplate.pathDesc",
          "Path to the markdown file used as the review template.",
        ),
      )

    let reviewTemplateController: FilePathFieldController | null = null
    let reviewTemplateSuggest: FilePathSuggest | null = null

    pathSetting.addText((text) => {
      reviewTemplateController = new FilePathFieldController({
        text,
        getStoredValue: () => this.plugin.settings.reviewTemplatePath ?? null,
        setStoredValue: (next) => {
          if (!next) {
            this.plugin.settings.reviewTemplatePath = null
          } else {
            this.plugin.settings.reviewTemplatePath = next
          }
        },
        saveSettings: () => this.plugin.saveSettings(),
        validatePath: (path) => this.plugin.pathManager.validatePath(path),
        fileExists: (path) => this.fileExists(path),
        makeMissingNotice: (path) =>
          t(
            "notices.reviewTemplateMissing",
            "Review template file was not found: {path}",
            { path },
          ),
        notice: (message) => new Notice(message),
        emptyValue: null,
      })

      reviewTemplateSuggest = new FilePathSuggest(
        this.app,
        text.inputEl,
        (filePath) => {
          void reviewTemplateController?.handleSuggestionSelect(filePath)
        },
      )

      text
        .setValue(this.plugin.settings.reviewTemplatePath ?? "")
        .onChange(async (raw) => {
          await reviewTemplateController?.handleInputChange(raw)
        })

      text.inputEl.addEventListener("focus", () => {
        reviewTemplateSuggest?.setValue(text.getValue())
        reviewTemplateSuggest?.open()
      })

      text.inputEl.addEventListener("blur", () => {
        void reviewTemplateController?.handleBlur()
      })
    })

    // Extra buttons removed per new design (no magnifier or clear icon).
  }
  private folderExists(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path)
    return abstract instanceof TFolder
  }

  private fileExists(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path)
    return abstract instanceof TFile
  }

  private renderStorageSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.heading", "TaskChute file paths"))
    this.setHeadingIfSupported(heading)

    // Base location dropdown
    new Setting(container)
      .setName(
        t("settings.storage.baseLocationName", "Default storage location"),
      )
      .setDesc(
        t(
          "settings.storage.baseLocationDesc",
          "Save task/log/review under the selected base.",
        ),
      )
      .addDropdown((dd) => {
        const current = this.plugin.settings.locationMode ?? "vaultRoot"
        dd.addOption(
          "vaultRoot",
          t(
            "settings.storage.baseOptions.vaultRoot",
            "Vault root (TaskChute/...)",
          ),
        )
        dd.addOption(
          "specifiedFolder",
          t(
            "settings.storage.baseOptions.specifiedFolder",
            "Below specified folder",
          ),
        )
        dd.setValue(current).onChange(async (val) => {
          const mode =
            val === "specifiedFolder" ? "specifiedFolder" : "vaultRoot"
          this.plugin.settings.locationMode = mode
          await this.plugin.saveSettings()
          this.display()
        })
      })

    // Specified folder (render only when mode === specifiedFolder)
    const isSpecified =
      (this.plugin.settings.locationMode ?? "vaultRoot") === "specifiedFolder"
    if (isSpecified) {
      new Setting(container)
        .setName(t("settings.storage.specifiedFolderName", "Specified folder"))
        .setDesc(
          t(
            "settings.storage.specifiedFolderDesc",
            "TaskChute/... will be created under this folder.",
          ),
        )
        .addText((text) => {
          const controller = new FolderPathFieldController({
            text,
            getStoredValue: () => this.plugin.settings.specifiedFolder,
            setStoredValue: (next) => {
              this.plugin.settings.specifiedFolder = next ?? undefined
            },
            saveSettings: () => this.plugin.saveSettings(),
            validatePath: (path) => this.plugin.pathManager.validatePath(path),
            folderExists: (path) => this.folderExists(path),
            makeMissingNotice: (path) =>
              t(
                "settings.validation.missingFolder",
                "Folder was not found: {path}",
                { path },
              ),
            notice: (message) => new Notice(message),
            emptyValue: undefined,
          })

          text
            .setValue(this.plugin.settings.specifiedFolder ?? "")
            .onChange(async (raw) => {
              await controller.handleInputChange(raw)
            })

          const suggest = new FolderPathSuggest(
            this.app,
            text.inputEl,
            (folderPath) => {
              void controller.handleSuggestionSelect(folderPath)
            },
          )

          text.inputEl.addEventListener("focus", () => {
            suggest.setValue(text.getValue())
            suggest.open()
          })

          text.inputEl.addEventListener("blur", () => {
            void controller.handleBlur()
          })
        })
    }
  }

  private renderProjectCandidateSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.projectCandidates.heading", "Projects"))
    this.setHeadingIfSupported(heading)

    new Setting(container)
      .setName(
        t("settings.projectCandidates.titlePrefixName", "File name prefix"),
      )
      .setDesc(
        t(
          "settings.projectCandidates.titlePrefixDesc",
          "Applied to project titles when creating new notes.",
        ),
      )
      .addText((text) => {
        const value = this.plugin.settings.projectTitlePrefix ?? "Project - "
        text.setValue(value).onChange(async (raw) => {
          this.plugin.settings.projectTitlePrefix = raw
          await this.plugin.saveSettings()
        })
      })

    let projectFolderController: FolderPathFieldController | null = null
    let projectFolderSuggest: FolderPathSuggest | null = null
    const folderSetting = new Setting(container)
      .setName(
        t("settings.projectCandidates.folderName", "Project files location"),
      )
      .setDesc(
        t(
          "settings.projectCandidates.folderDesc",
          "Folder where project notes will be saved.",
        ),
      )

    folderSetting.addText((text) => {
      projectFolderController = new FolderPathFieldController({
        text,
        getStoredValue: () => this.plugin.settings.projectsFolder ?? undefined,
        setStoredValue: (next) => {
          if (next === null || next === undefined || next === "") {
            this.plugin.settings.projectsFolder = null
          } else {
            this.plugin.settings.projectsFolder = next
          }
        },
        saveSettings: () => this.plugin.saveSettings(),
        validatePath: (path) => this.plugin.pathManager.validatePath(path),
        folderExists: (path) => this.folderExists(path),
        makeMissingNotice: (path) =>
          t(
            "settings.validation.missingFolder",
            "Folder was not found: {path}",
            { path },
          ),
        notice: (message) => new Notice(message),
        emptyValue: null,
      })

      text
        .setValue(this.plugin.settings.projectsFolder ?? "")
        .onChange(async (raw) => {
          await projectFolderController?.handleInputChange(raw)
        })

      projectFolderSuggest = new FolderPathSuggest(
        this.app,
        text.inputEl,
        (folderPath) => {
          void projectFolderController?.handleSuggestionSelect(folderPath)
        },
      )

      text.inputEl.addEventListener("focus", () => {
        projectFolderSuggest?.setValue(text.getValue())
        projectFolderSuggest?.open()
      })

      text.inputEl.addEventListener("blur", () => {
        void projectFolderController?.handleBlur()
      })
    })

    let projectTemplateController: FilePathFieldController | null = null
    let projectTemplateSuggest: FilePathSuggest | null = null
    const templateSetting = new Setting(container)
      .setName(t("settings.projectCandidates.templateName", "Template file"))
      .setDesc(
        t(
          "settings.projectCandidates.templateDesc",
          "Optional markdown template applied when creating new projects.",
        ),
      )

    templateSetting.addText((text) => {
      projectTemplateController = new FilePathFieldController({
        text,
        getStoredValue: () => this.plugin.settings.projectTemplatePath ?? null,
        setStoredValue: (next) => {
          if (!next) {
            this.plugin.settings.projectTemplatePath = null
          } else {
            this.plugin.settings.projectTemplatePath = next
          }
        },
        saveSettings: () => this.plugin.saveSettings(),
        validatePath: (path) => this.plugin.pathManager.validatePath(path),
        fileExists: (path) => this.fileExists(path),
        makeMissingNotice: (path) =>
          t(
            "notices.projectTemplateMissing",
            "Project template file was not found: {path}",
            { path },
          ),
        notice: (message) => new Notice(message),
        emptyValue: null,
      })

      projectTemplateSuggest = new FilePathSuggest(
        this.app,
        text.inputEl,
        (filePath) => {
          void projectTemplateController?.handleSuggestionSelect(filePath)
        },
      )

      const value = this.plugin.settings.projectTemplatePath ?? ""
      text.setValue(value).onChange(async (raw) => {
        await projectTemplateController?.handleInputChange(raw)
      })

      text.inputEl.addEventListener("blur", () => {
        void projectTemplateController?.handleBlur()
      })

      text.inputEl.addEventListener("focus", () => {
        projectTemplateSuggest?.setValue(text.getValue())
        projectTemplateSuggest?.open()
      })
    })
  }

  private renderGoogleCalendarSection(container: HTMLElement): void {
    new Setting(container)
      .setName(
        t(
          "settings.googleCalendar.enable",
          "Googleカレンダーへの登録を有効にする",
        ),
      )
      .setDesc(
        t(
          "settings.googleCalendar.enableDesc",
          "タスク設定メニューに「Googleカレンダーに登録」を表示し、ブラウザで登録画面を開きます。",
        ),
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.googleCalendar?.enabled ?? false)
          .onChange(async (value) => {
            this.plugin.settings.googleCalendar = {
              ...this.plugin.settings.googleCalendar,
              enabled: value,
              includeNoteContent: true,
            }
            await this.plugin.saveSettings()
          })
      })
  }

  private renderAdvancedSection(container: HTMLElement): void {
    const details = container.createEl('details', { cls: 'taskchute-advanced-settings' })
    const summary = details.createEl('summary', { cls: 'taskchute-advanced-summary' })
    summary.createEl('span', {
      cls: 'taskchute-advanced-heading',
      text: t('settings.advanced.heading', 'Advanced settings'),
    })

    const content = details.createEl('div', { cls: 'taskchute-advanced-content' })
    this.renderSectionCustomization(content)
    this.renderFeaturesSection(content)
  }

  private renderSectionCustomization(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t('settings.advanced.sectionCustomize.heading', 'Section customization'))
    this.setHeadingIfSupported(heading)

    // Draft state: copy current boundaries for editing
    const current = SectionConfigService.sanitizeBoundaries(this.plugin.settings.customSections)
      ?? [...SectionConfigService.DEFAULT_BOUNDARIES]
    const draft: SectionBoundary[] = current.map(b => ({ ...b }))

    const listEl = container.createEl('div', { cls: 'taskchute-section-boundaries' })

    const renderBoundaryList = () => {
      listEl.empty()
      draft.forEach((boundary, idx) => {
        const row = listEl.createEl('div', { cls: 'taskchute-boundary-row' })

        row.createEl('span', {
          cls: 'taskchute-boundary-label',
          text: t('settings.advanced.sectionCustomize.boundaryLabel', `Boundary ${idx + 1}`, { index: idx + 1 }),
        })

        const input = row.createEl('input', {
          cls: 'taskchute-boundary-input',
          type: 'text',
          attr: { placeholder: 'Enter time (hh:mm)' },
        })
        input.value = `${String(boundary.hour).padStart(2, '0')}:${String(boundary.minute).padStart(2, '0')}`

        input.addEventListener('change', () => {
          const match = input.value.trim().match(/^(\d{1,2}):(\d{2})$/)
          if (match) {
            const h = parseInt(match[1], 10)
            const m = parseInt(match[2], 10)
            if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
              draft[idx] = { hour: h, minute: m }
              return
            }
          }
          new Notice(t('settings.advanced.sectionCustomize.validation.invalidFormat', 'Please enter in HH:MM format'))
          const currentBoundary = draft[idx] ?? boundary
          input.value = `${String(currentBoundary.hour).padStart(2, '0')}:${String(currentBoundary.minute).padStart(2, '0')}`
        })

        // Delete button (only if more than 2 boundaries)
        if (draft.length > 2) {
          const deleteBtn = row.createEl('button', {
            cls: 'taskchute-boundary-delete',
            text: t('settings.advanced.sectionCustomize.removeBoundary', 'Remove'),
          })
          deleteBtn.addEventListener('click', () => {
            draft.splice(idx, 1)
            renderBoundaryList()
          })
        }
      })
    }

    renderBoundaryList()

    // Buttons row
    const buttonsEl = container.createEl('div', { cls: 'taskchute-section-buttons' })

    // Add boundary button
    const addBtn = buttonsEl.createEl('button', {
      text: t('settings.advanced.sectionCustomize.addBoundary', 'Add boundary'),
    })
    addBtn.addEventListener('click', () => {
      const lastBoundary = draft[draft.length - 1]
      const newHour = Math.min(23, lastBoundary.hour + 4)
      draft.push({ hour: newHour, minute: 0 })
      renderBoundaryList()
    })

    // Reset button
    const resetBtn = buttonsEl.createEl('button', {
      text: t('settings.advanced.sectionCustomize.resetDefault', 'Reset to default'),
    })
    resetBtn.addEventListener('click', () => {
      draft.length = 0
      SectionConfigService.DEFAULT_BOUNDARIES.forEach(b => draft.push({ ...b }))
      renderBoundaryList()
    })

    // Apply button
    const applyBtn = buttonsEl.createEl('button', {
      cls: 'mod-cta',
      text: t('settings.advanced.sectionCustomize.apply', 'Apply'),
    })
    applyBtn.addEventListener('click', () => {
      void (async () => {
        // Sort draft ascending
        draft.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute))
        renderBoundaryList()

        // Validate
        if (draft.length < 2) {
          new Notice(t('settings.advanced.sectionCustomize.validation.minimum', 'At least 2 boundaries are required'))
          return
        }
        if (draft[0].hour !== 0 || draft[0].minute !== 0) {
          new Notice(t('settings.advanced.sectionCustomize.validation.firstMustBeZero', 'The first boundary must be 0:00'))
          return
        }
        // Check duplicates and ascending
        for (let i = 1; i < draft.length; i++) {
          const prev = draft[i - 1].hour * 60 + draft[i - 1].minute
          const curr = draft[i].hour * 60 + draft[i].minute
          if (curr === prev) {
            new Notice(t('settings.advanced.sectionCustomize.validation.duplicate', 'Duplicate boundary times exist'))
            return
          }
          if (curr < prev) {
            new Notice(t('settings.advanced.sectionCustomize.validation.notAscending', 'Boundaries must be in ascending order'))
            return
          }
        }

        // Check if boundaries actually changed
        const currentSections = this.plugin.settings.customSections
        const sanitized = SectionConfigService.sanitizeBoundaries(currentSections) ?? SectionConfigService.DEFAULT_BOUNDARIES
        const isDefault = draft.length === SectionConfigService.DEFAULT_BOUNDARIES.length
          && draft.every((b, i) => b.hour === SectionConfigService.DEFAULT_BOUNDARIES[i].hour && b.minute === SectionConfigService.DEFAULT_BOUNDARIES[i].minute)
        const isUnchanged = draft.length === sanitized.length
          && draft.every((b, i) => b.hour === sanitized[i].hour && b.minute === sanitized[i].minute)

        if (isUnchanged) {
          new Notice(t('settings.advanced.sectionCustomize.noChanges', 'No changes to apply'))
          return
        }

        // Confirm
        const confirmed = await showConfirmModal(this.app, {
          title: t('settings.advanced.sectionCustomize.confirmDialog.title', 'Change section boundaries'),
          message: t('settings.advanced.sectionCustomize.confirmDialog.body', 'Changing section boundaries will recalculate slot assignments for existing tasks. Continue?'),
          confirmText: t('settings.advanced.sectionCustomize.confirmDialog.confirm', 'Apply'),
          cancelText: t('settings.advanced.sectionCustomize.confirmDialog.cancel', 'Cancel'),
        })
        if (!confirmed) return

        try {
          await this.applySectionCustomization(isDefault ? undefined : draft.map(b => ({ ...b })))
          new Notice(t('settings.advanced.sectionCustomize.applied', 'Section boundaries updated'))
        } catch (error) {
          console.error('[SettingsTab] section customization failed', error)
          new Notice(t('settings.advanced.sectionCustomize.migrationFailed', 'An error occurred while recalculating slot assignments'))
        }
      })()
    })

    // Migration notice
    container.createEl('p', {
      cls: 'setting-item-description taskchute-section-notice',
      text: t('settings.advanced.sectionCustomize.migrationNotice', 'Changing section boundaries will automatically recalculate slot assignments for existing tasks.'),
    })
  }

  private async applySectionCustomization(newBoundaries: SectionBoundary[] | undefined): Promise<void> {
    // 1. Migrate settings.slotKeys – keep manual assignments by mapping old keys to new boundaries
    const newConfig = new SectionConfigService(newBoundaries)
    const migratedSlotKeys: Record<string, string> = {}
    for (const [taskId, oldSlot] of Object.entries(this.plugin.settings.slotKeys)) {
      migratedSlotKeys[taskId] = newConfig.isValidSlotKey(oldSlot)
        ? oldSlot
        : newConfig.migrateSlotKey(oldSlot)
    }
    this.plugin.settings.slotKeys = migratedSlotKeys
    this.plugin.settings.customSections = newBoundaries

    // 2. Save settings
    await this.plugin.saveSettings()

    // 3. Notify all open Views
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
    const results = await Promise.allSettled(
      leaves.map(leaf => {
        const view = leaf.view as { onSectionSettingsChanged?: () => Promise<void> }
        if (typeof view.onSectionSettingsChanged === 'function') {
          return view.onSectionSettingsChanged()
        }
        return Promise.resolve()
      })
    )
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[SettingsTab] section update failed', r.reason)
      }
    }
  }

  private renderFeaturesSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.features.heading", "External tools"))
    this.setHeadingIfSupported(heading)

    new Setting(container)
      .setName(t("settings.features.robotButton", "Show terminal button"))
      .setDesc(
        t(
          "settings.features.robotButtonDesc",
          `Enable AI integration via ${TERMINAL_NAME} (requires ${TERMINAL_NAME} plugin).`,
        ),
      )
      .addToggle((tg) => {
        tg.setValue(
          this.plugin.settings.aiRobotButtonEnabled ?? false,
        ).onChange(async (v) => {
          this.plugin.settings.aiRobotButtonEnabled = v
          await this.plugin.saveSettings()
        })
      })

    this.renderGoogleCalendarSection(container)
  }
}

class FolderPathSuggest extends AbstractInputSuggest<TFolder> {
  private readonly onChoose: (folderPath: string) => void
  private readonly textInputEl: HTMLInputElement

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onChoose: (folderPath: string) => void,
  ) {
    super(app, inputEl)
    this.textInputEl = inputEl
    this.onChoose = onChoose
  }

  setValue(value: string): void {
    this.textInputEl.value = value
  }

  protected getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase()
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path.toLowerCase().includes(lower))
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path)
  }

  selectSuggestion(folder: TFolder): void {
    void this.onChoose(folder.path)
    this.close()
  }
}
