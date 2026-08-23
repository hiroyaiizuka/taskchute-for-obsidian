import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, AbstractInputSuggest } from "obsidian"
import { TaskChuteSettings, SectionBoundary, PathManagerLike, VIEW_TYPE_TASKCHUTE } from "../types"
import { t } from "../i18n"
import { TERMINAL_NAME } from "../constants"
import { createAiTaskManager } from "../features/ai-task"
import type { AiTaskManager } from "../features/ai-task/services/AiTaskManager"
import { disposeAiTaskManagerTracked } from "../features/ai-task/registerProcessCleanup"
import { syncAiTaskManagerToLicense } from "../features/ai-task/licenseGate"
import { ElectronDirectoryPicker } from "../features/ai-task/services/ElectronDirectoryPicker"
import type { LicenseManager } from "../features/license/services/LicenseManager"
import { formatLicenseId } from "../features/license/token/primitives"
import { DeviceListView } from "../features/license/ui/DeviceListView"
import {
  describeActivationFailure,
  describeApiFailure,
} from "../features/license/ui/licenseMessages"
import { FolderPathFieldController } from "./folderPathFieldController"
import { FilePathFieldController } from "./filePathFieldController"
import { FilePathSuggest } from "./filePathSuggest"
import { getPathSuggestParentFolder } from "./pathSuggestUtils"
import { SectionConfigService } from "../services/SectionConfigService"
import { showConfirmModal } from "../ui/modals/ConfirmModal"
import { listFoldersInFolder, type VaultFolderEntry } from "../utils/vaultFiles"

function isUnsupportedWindowsCliShim(path: string): boolean {
  return /\.(?:bat|cmd|ps1)$/iu.test(path)
}

interface PluginWithSettings extends Plugin {
  app: App
  settings: TaskChuteSettings
  pathManager: PathManagerLike
  aiTaskManager?: AiTaskManager
  aiTaskManagersPendingDisposal?: Set<AiTaskManager>
  aiTaskLifecycleActive?: boolean
  aiTaskLifecycleGeneration?: number
  aiTaskRuntimeLeaseGeneration?: number
  licenseManager?: LicenseManager
  saveSettings(): Promise<void>
  _log?(level?: string, ...args: unknown[]): void
}

/**
 * AI tasks are still in preparation, so the Pro section — the license form and
 * the AI settings it unlocks — stays hidden until the version card is clicked
 * this many times. Only for vaults without a license; an active one shows the
 * section outright.
 */
const PRO_SECTION_UNLOCK_CLICKS = 10

export class TaskChuteSettingTab extends PluginSettingTab {
  plugin: PluginWithSettings
  /** Rejects an older async toggle completion after a newer operation wins. */
  private aiTaskToggleOperation = 0
  /** Disposed on every redraw so an in-flight request cannot write into a stale tree. */
  private deviceListView?: DeviceListView
  /**
   * The click unlock, kept on the tab instance so it lapses after a reload.
   * Only ever matters without a license: an active one shows the section on
   * its own, and losing it hides the section again.
   */
  private proSectionUnlocked = false
  private versionClickCount = 0

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
    // Last, and collapsed: the license and everything it unlocks are set once
    // and then left alone, so they stay out of the way of the daily settings.
    if (this.isProSectionVisible()) {
      this.renderProSection(containerEl)
    }
    this.renderVersionSection(containerEl)
  }

  /**
   * Whether to draw the Pro section.
   *
   * The hidden click unlock is for people who do not have a license yet, so it
   * must not be the only way in: once a license is active the section is the
   * only place to manage seats and AI settings, and re-discovering the unlock
   * after every reload would strand a paying user.
   */
  private isProSectionVisible(): boolean {
    if (this.proSectionUnlocked) return true

    // Deliberately not latched: releasing this device drops the state back to
    // unlicensed, and the section has to disappear with it rather than leave
    // an activation form behind for a feature that is hidden again.
    return this.plugin.licenseManager?.getState().status === "active"
  }

  /**
   * A collapsed `details` block whose summary doubles as the section heading.
   * Shared by the advanced and Pro sections so both fold the same way.
   */
  private createCollapsibleSection(
    container: HTMLElement,
    heading: string,
  ): HTMLElement {
    const details = container.createEl('details', { cls: 'taskchute-collapsible-section' })
    const summary = details.createEl('summary', { cls: 'taskchute-collapsible-summary' })
    summary.createSpan({ cls: 'taskchute-collapsible-heading', text: heading })

    return details.createDiv({ cls: 'taskchute-collapsible-content' })
  }

  /** インストール済みのバージョンを manifest.json からそのまま表示する */
  private renderVersionSection(container: HTMLElement): void {
    const setting = new Setting(container)
      .setClass('taskchute-version-setting')
      .setName(t("settings.version.name", "Version"))
      .setDesc(this.plugin.manifest.version)

    setting.settingEl?.addEventListener('click', () => {
      this.handleVersionClick()
    })
  }

  /** 準備中の Pro セクションを、規定回数のクリックで解禁する隠し操作 */
  private handleVersionClick(): void {
    if (this.isProSectionVisible()) return

    this.versionClickCount += 1
    if (this.versionClickCount < PRO_SECTION_UNLOCK_CLICKS) return

    this.proSectionUnlocked = true
    this.versionClickCount = 0
    new Notice(
      t("settings.version.proUnlocked", "Pro settings are now visible."),
    )
    this.display()
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

  private renderTaskCreationSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.taskCreation.heading", "Task creation"))
    this.setHeadingIfSupported(heading)

    new Setting(container)
      .setName(
        t(
          "settings.taskCreation.showAdvancedName",
          "Show advanced settings in the task creation modal",
        ),
      )
      .setDesc(
        t(
          "settings.taskCreation.showAdvancedDesc",
          "Adds start time, reminder, and calendar options to the new task modal.",
        ),
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showTaskCreationAdvancedSettings ?? false)
          .onChange(async (value) => {
            this.plugin.settings.showTaskCreationAdvancedSettings = value
            await this.plugin.saveSettings()
          })
      })

    const defaultReminderSetting = new Setting(container)
      .setName(t("settings.reminder.defaultMinutesName", "Default reminder time (minutes)"))
      .setDesc(t("settings.reminder.defaultMinutesDesc", "Default value when setting a new reminder."))
      .addText((text) => {
        text.inputEl.type = "number"
        text.inputEl.min = "0"
        text.inputEl.step = "1"
        const current = this.plugin.settings.defaultReminderMinutes ?? 5
        text
          .setPlaceholder("5")
          .setValue(String(current))
          .onChange(async (raw) => {
            const parsed = Number(raw)
            const normalized = Number.isFinite(parsed)
              ? Math.max(0, Math.round(parsed))
              : 5
            this.plugin.settings.defaultReminderMinutes = normalized
            await this.plugin.saveSettings()
          })
      })

    defaultReminderSetting.controlEl?.addClass("taskchute-number-input")
    this.renderGoogleCalendarSection(container)
  }

  private renderAdvancedSection(container: HTMLElement): void {
    const content = this.createCollapsibleSection(
      container,
      t('settings.advanced.heading', 'Advanced settings'),
    )
    this.renderTaskCreationSection(content)
    this.renderRecipeFeatureSection(content)
    // The license and AI task settings live in the Pro section below.
    this.renderSectionCustomization(content)
    this.renderCollapsibleTimeSlotsToggle(content)
    this.renderFeaturesSection(content)
  }

  private renderRecipeFeatureSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.recipe.heading", "Recipes"))
    this.setHeadingIfSupported(heading)

    new Setting(container)
      .setName(t("settings.recipe.enable", "Enable recipe feature"))
      .setDesc(
        t(
          "settings.recipe.enableDesc",
          "Show recipe setup and management entry points in the task menu and side navigation.",
        ),
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.recipeFeatureEnabled ?? false)
          .onChange(async (value) => {
            this.plugin.settings.recipeFeatureEnabled = value
            await this.plugin.saveSettings()
            this.notifyRecipeFeatureSettingsChanged()
          })
      })
  }

  private notifyRecipeFeatureSettingsChanged(): void {
    const workspace = this.app.workspace as {
      getLeavesOfType?: (type: string) => Array<{ view?: unknown }>
    }
    const leaves = typeof workspace.getLeavesOfType === "function"
      ? workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
      : []
    leaves.forEach((leaf) => {
      const view = leaf.view as {
        onRecipeFeatureSettingsChanged?: () => void
        renderTaskList?: () => void
      } | undefined
      if (typeof view?.onRecipeFeatureSettingsChanged === "function") {
        view.onRecipeFeatureSettingsChanged()
        return
      }
      view?.renderTaskList?.()
    })
  }

  /**
   * Pro settings: everything the license unlocks, plus the license itself.
   *
   * Two shapes, chosen by entitlement. Activated, it shows the license, the
   * device seats and the AI task settings. Otherwise it shows only the
   * activation form — rendered rather than hidden, because someone who just
   * bought the plugin needs somewhere to enter their code.
   */
  private renderProSection(container: HTMLElement): void {
    // A previous render may still have a device request in flight; it must not
    // write into the container display() is about to replace.
    this.deviceListView?.dispose()
    this.deviceListView = undefined

    const content = this.createCollapsibleSection(
      container,
      t("settings.pro.heading", "Pro settings"),
    )

    const manager = this.plugin.licenseManager
    if (!manager) {
      // The manager is created during bootstrap; its absence means that failed.
      new Setting(content).setDesc(
        t(
          "license.errors.internal",
          "The license service returned an unexpected error. Try again later.",
        ),
      )
      return
    }

    if (manager.getState().status === "active") {
      this.renderActiveLicense(content, manager)
      this.renderAiTaskSection(content)
      return
    }

    this.renderLicenseActivation(content, manager)
  }

  private renderActiveLicense(container: HTMLElement, manager: LicenseManager): void {
    const summary = manager.getLicenseSummary()

    new Setting(container)
      .setName(t("settings.license.statusName", "Status"))
      .setDesc(t("settings.license.statusActive", "Active"))

    if (summary) {
      new Setting(container)
        .setName(t("settings.license.licenseIdName", "License ID"))
        .setDesc(formatLicenseId(summary.license_id))

      new Setting(container)
        .setName(t("settings.license.expiresName", "Expires"))
        .setDesc(
          summary.expires_at === null
            ? t("settings.license.expiresNever", "No expiry")
            : new Date(summary.expires_at * 1000).toLocaleDateString(),
        )
    }

    const devicesHeading = new Setting(container).setName(
      t("settings.license.devicesName", "Devices"),
    )
    this.setHeadingIfSupported(devicesHeading)
    // Releasing this very device is done from the list like any other seat, so
    // there is no separate sign-out control. Seat counts come from the server,
    // so a release has to re-read the license summary; a full redraw is the
    // cheapest way to stay consistent.
    this.deviceListView = new DeviceListView(container, manager, {
      onChanged: () => {
        void manager
          .refreshIfNeeded(true)
          .then(() => this.applyLicenseChange())
          .then(() => this.display())
      },
    })
  }

  private renderLicenseActivation(container: HTMLElement, manager: LicenseManager): void {
    const state = manager.getState()
    if (state.status === "blocked") {
      new Setting(container).setDesc(
        describeApiFailure({ ok: false, kind: "api", code: state.reason, status: 403 }),
      )
    }

    new Setting(container).setDesc(
      t(
        "settings.license.description",
        "AI tasks require a TaskChute Plus Pro license. Enter the activation code from your purchase email.",
      ),
    )

    let code = this.plugin.settings.licenseCode ?? ""
    // Holds the seat list after a 409, below the form the user just used.
    const seatLimitEl = container.createDiv()

    const setting = new Setting(container)
      .setName(t("settings.license.codeName", "Activation code"))
      .addText((text) => {
        text
          .setPlaceholder(t("settings.license.codePlaceholder", "TCP-XXXX-XXXX-XXXX-XXXX"))
          .setValue(code)
          .onChange((value) => {
            code = value
          })
      })
      .addButton((button) => {
        button.setCta().setButtonText(t("settings.license.activate", "Activate"))
        button.onClick(async () => {
          button.setDisabled(true)
          button.setButtonText(t("settings.license.activating", "Activating…"))
          this.deviceListView?.dispose()
          this.deviceListView = undefined
          seatLimitEl.empty()

          const result = await manager.activate(code)

          if (result.ok) {
            new Notice(t("settings.license.activated", "License activated."))
            await this.applyLicenseChange()
            this.display()
            return
          }

          button.setDisabled(false)
          button.setButtonText(t("settings.license.activate", "Activate"))
          setting.setDesc(describeActivationFailure(result.failure))

          // The seat limit is the one failure the user can fix right here, and
          // the 409 already carried the list, so no second request is needed.
          if (result.failure.kind === "device-limit") {
            this.deviceListView = new DeviceListView(seatLimitEl, manager, {
              initialDevices: result.failure.devices,
              // Freeing a seat makes the "limit reached" message stale.
              onChanged: () => {
                setting.setDesc("")
              },
            })
          }
        })
      })
  }

  /** Create or dispose the AI runtime to match the new license state. */
  private async applyLicenseChange(): Promise<void> {
    try {
      await syncAiTaskManagerToLicense(this.plugin)
    } catch (error) {
      this.plugin._log?.("warn", "[License] Failed to apply license change", error)
    }
    this.notifyAiTaskSettingsChanged()
  }

  /** Only reached from the Pro section, which has already checked the license. */
  private renderAiTaskSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t("settings.aiTask.heading", "AI task"))
    this.setHeadingIfSupported(heading)

    new Setting(container)
      .setName(t("settings.aiTask.enable", "Enable AI tasks"))
      .setDesc(
        t(
          "settings.aiTask.enableDesc",
          "Run tasks with the claude or codex CLI inside the AI run pane (desktop only).",
        ),
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.aiTaskEnabled ?? false)
          .onChange(async (value) => {
            const operation = (this.aiTaskToggleOperation ?? 0) + 1
            const lifecycleGeneration = this.plugin.aiTaskLifecycleGeneration
            this.aiTaskToggleOperation = operation
            this.plugin.settings.aiTaskEnabled = value
            await this.plugin.saveSettings()
            // Settings tabs belong to one Plugin instance. A hot reload can
            // replace that instance while saveSettings is pending; the old
            // callback must never dispose or re-adopt the new owner's manager.
            if (!this.isAiTaskToggleRequestCurrent(
              operation,
              lifecycleGeneration,
              value,
            )) return
            const applied = await this.applyAiTaskEnabledChange(
              value,
              operation,
              lifecycleGeneration,
            )
            if (
              !applied ||
              !this.isAiTaskToggleRequestCurrent(
                operation,
                lifecycleGeneration,
                value,
              )
            ) return
            this.notifyAiTaskSettingsChanged()
          })
      })

    new Setting(container)
      .setName(t("settings.aiTask.runModeName", "Run mode"))
      .setDesc(
        t(
          "settings.aiTask.runModeDesc",
          "Terminal embeds the interactive CLI session on macOS and Linux; conversation mode streams parsed events and supports follow-up input on every desktop platform. Windows automatically uses it because the plugin does not bundle a native pseudoterminal runtime.",
        ),
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption(
            "terminal",
            t("settings.aiTask.runModeTerminal", "Terminal (interactive)"),
          )
          .addOption(
            "headless",
            t("settings.aiTask.runModeHeadless", "Conversation (cross-platform)"),
          )
          .setValue(
            this.plugin.settings.aiTaskRunMode === "headless"
              ? "headless"
              : "terminal",
          )
          .onChange(async (value) => {
            this.plugin.settings.aiTaskRunMode =
              value === "headless" ? "headless" : "terminal"
            await this.plugin.saveSettings()
          })
      })

    this.renderAiTaskCliPathSetting(container, {
      name: t("settings.aiTask.claudePathName", "Claude CLI path (advanced fallback)"),
      desc: t(
        "settings.aiTask.claudePathDesc",
        "Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.",
      ),
      getValue: () => this.plugin.settings.aiTaskClaudePath ?? "",
      setValue: (value) => {
        this.plugin.settings.aiTaskClaudePath = value
      },
    })

    this.renderAiTaskCliPathSetting(container, {
      name: t("settings.aiTask.codexPathName", "Codex CLI path (advanced fallback)"),
      desc: t(
        "settings.aiTask.codexPathDesc",
        "Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.",
      ),
      getValue: () => this.plugin.settings.aiTaskCodexPath ?? "",
      setValue: (value) => {
        this.plugin.settings.aiTaskCodexPath = value
      },
    })

    const retentionSetting = new Setting(container)
      .setName(t("settings.aiTask.retentionName", "Run log retention (days)"))
      .setDesc(
        t(
          "settings.aiTask.retentionDesc",
          "Run log notes older than this many days are deleted automatically.",
        ),
      )
      .addText((text) => {
        text.inputEl.type = "number"
        text.inputEl.min = "1"
        text.inputEl.step = "1"
        const current = this.plugin.settings.aiTaskLogRetentionDays ?? 30
        text
          .setPlaceholder("30")
          .setValue(String(current))
          .onChange(async (raw) => {
            const parsed = Number(raw)
            const normalized = Number.isFinite(parsed)
              ? Math.max(1, Math.round(parsed))
              : 30
            this.plugin.settings.aiTaskLogRetentionDays = normalized
            await this.plugin.saveSettings()
          })
      })

    retentionSetting.controlEl?.addClass("taskchute-number-input")
  }

  /**
   * CLI path row: name/description stacked above a full-width text field with a
   * native "Browse" picker, so long absolute paths stay readable.
   */
  private renderAiTaskCliPathSetting(
    container: HTMLElement,
    options: {
      name: string
      desc: string
      getValue: () => string
      setValue: (value: string) => void
    },
  ): void {
    const setting = new Setting(container)
      .setName(options.name)
      .setDesc(options.desc)
    setting.settingEl?.addClass("taskchute-cli-path-setting")

    let textComponent: { setValue(value: string): unknown } | undefined

    const commit = async (raw: string): Promise<void> => {
      const normalized = raw.trim()
      const rejected = isUnsupportedWindowsCliShim(normalized)
      if (rejected) {
        textComponent?.setValue("")
        new Notice(
          t(
            "settings.aiTask.pathShimUnsupported",
            "Windows .cmd/.bat/.ps1 shims cannot be used as manual CLI paths. Leave this empty for auto-detection or select the actual executable/package entrypoint.",
          ),
        )
      }
      options.setValue(rejected ? "" : normalized)
      await this.plugin.saveSettings()
      this.plugin.aiTaskManager?.invalidateBinaryCache()
    }

    setting.addText((text) => {
      textComponent = text
      text
        .setPlaceholder(
          t("settings.aiTask.pathPlaceholder", "Auto-detect (recommended)"),
        )
        .setValue(options.getValue())
        .onChange(async (value) => {
          await commit(value)
        })
    })

    setting.addButton((button) => {
      button
        .setButtonText(t("settings.aiTask.pathBrowse", "Browse"))
        .onClick(async () => {
          const selected = await new ElectronDirectoryPicker().selectFile({
            defaultPath: options.getValue(),
            title: options.name,
          })
          if (!selected) return
          textComponent?.setValue(selected)
          await commit(selected)
        })
    })
  }

  /** Create or dispose the AiTaskManager to match the toggle state. */
  private async applyAiTaskEnabledChange(
    enabled: boolean,
    operation: number,
    lifecycleGeneration: number | undefined,
  ): Promise<boolean> {
    if (enabled) {
      const pending = this.plugin.aiTaskManagersPendingDisposal
      const disposingManagers = Array.from(pending ?? [])
      if (disposingManagers.length > 0) {
        const results = await Promise.allSettled(
          disposingManagers.map(async (manager) => {
            await manager.disposeAndWait()
            pending?.delete(manager)
          }),
        )
        if (!this.isAiTaskToggleRequestCurrent(
          operation,
          lifecycleGeneration,
          true,
        )) return false
        if (results.some((result) => result.status === 'rejected')) {
          // A new manager uses the same vault-scoped broker identity. Starting
          // it while the previous manager still owns an in-flight shutdown
          // lets that old shutdown kill the new run. Fail closed and persist
          // the actual disabled runtime state instead.
          this.plugin.settings.aiTaskEnabled = false
          await this.plugin.saveSettings()
          new Notice(
            t(
              'settings.aiTask.previousRuntimeShutdownFailed',
              'The previous AI runtime could not be stopped safely. AI tasks remain disabled; please try again.',
            ),
          )
          return false
        }
      }
      if (!this.plugin.aiTaskManager) {
        // Returns undefined off-desktop; the factory owns the platform gate.
        this.plugin.aiTaskManager = createAiTaskManager(this.plugin)
      }
      return true
    }
    const manager = this.plugin.aiTaskManager
    if (manager) disposeAiTaskManagerTracked(this.plugin, manager)
    this.plugin.aiTaskManager = undefined
    this.plugin.aiTaskRuntimeLeaseGeneration = undefined
    return true
  }

  private isAiTaskToggleRequestCurrent(
    operation: number,
    lifecycleGeneration: number | undefined,
    enabled: boolean,
  ): boolean {
    return (
      this.aiTaskToggleOperation === operation &&
      this.plugin.settings.aiTaskEnabled === enabled &&
      this.isCurrentPluginInstance(lifecycleGeneration)
    )
  }

  /**
   * Obsidian keeps the current Plugin instance in its internal registry.
   * Use it only as a stale-callback guard; lightweight test hosts without the
   * registry retain the normal behavior.
   */
  private isCurrentPluginInstance(
    expectedLifecycleGeneration: number | undefined,
  ): boolean {
    if (this.plugin.aiTaskLifecycleActive === false) return false
    if (
      expectedLifecycleGeneration !== undefined &&
      this.plugin.aiTaskLifecycleGeneration !== expectedLifecycleGeneration
    ) {
      return false
    }
    const appWithPlugins = this.app as App & {
      plugins?: { plugins?: Record<string, unknown> }
    }
    const registry = appWithPlugins.plugins?.plugins
    if (!registry) return true
    const pluginId = this.plugin.manifest?.id
    return typeof pluginId === "string" && registry[pluginId] === this.plugin
  }

  private notifyAiTaskSettingsChanged(): void {
    const workspace = this.app.workspace as {
      getLeavesOfType?: (type: string) => Array<{ view?: unknown }>
    }
    const leaves = typeof workspace.getLeavesOfType === "function"
      ? workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
      : []
    leaves.forEach((leaf) => {
      const view = leaf.view as {
        onAiTaskSettingsChanged?: () => void
        renderTaskList?: () => void
      } | undefined
      if (typeof view?.onAiTaskSettingsChanged === "function") {
        view.onAiTaskSettingsChanged()
        return
      }
      view?.renderTaskList?.()
    })
  }

  private renderSectionCustomization(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName(t('settings.advanced.sectionCustomize.heading', 'Section customization'))
    this.setHeadingIfSupported(heading)

    // Draft state: copy current boundaries for editing
    const current = SectionConfigService.sanitizeBoundaries(this.plugin.settings.customSections)
      ?? [...SectionConfigService.DEFAULT_BOUNDARIES]
    const draft: SectionBoundary[] = current.map(b => ({ ...b }))

    const listEl = container.createDiv( { cls: 'taskchute-section-boundaries' })

    const renderBoundaryList = () => {
      listEl.empty()
      draft.forEach((boundary, idx) => {
        const row = listEl.createDiv( { cls: 'taskchute-boundary-row' })

        row.createSpan( {
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
    const buttonsEl = container.createDiv( { cls: 'taskchute-section-buttons' })

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

  private renderCollapsibleTimeSlotsToggle(container: HTMLElement): void {
    new Setting(container)
      .setName(t("settings.advanced.collapsibleTimeSlots", "Collapsible time slots"))
      .setDesc(t("settings.advanced.collapsibleTimeSlotsDesc", "Click time slot headers to collapse/expand sections"))
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.collapsibleTimeSlots ?? false)
          .onChange(async (v) => {
            this.plugin.settings.collapsibleTimeSlots = v
            await this.plugin.saveSettings()
            // Notify open views to re-render
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
            for (const leaf of leaves) {
              const view = leaf.view as { renderTaskList?: () => void }
              if (typeof view.renderTaskList === 'function') {
                view.renderTaskList()
              }
            }
          })
      })
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
  }
}

class FolderPathSuggest extends AbstractInputSuggest<VaultFolderEntry> {
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

  protected getSuggestions(query: string): VaultFolderEntry[] {
    const lower = query.toLowerCase()
    const parentFolder = getPathSuggestParentFolder(query)
    return listFoldersInFolder(this.app, parentFolder, { recursive: false })
      .filter((folder) => folder.path.toLowerCase().includes(lower))
  }

  renderSuggestion(folder: VaultFolderEntry, el: HTMLElement): void {
    el.setText(folder.path)
  }

  selectSuggestion(folder: VaultFolderEntry): void {
    void this.onChoose(folder.path)
    this.close()
  }
}
