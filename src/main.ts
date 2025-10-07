import { Notice, Plugin } from "obsidian"

import { TaskChuteSettings } from "./types"
import { DEFAULT_SETTINGS } from "./settings"
import { PathManager } from "./managers/PathManager"
import { RoutineAliasManager } from "./managers/RoutineAliasManager"
import { TaskChuteView } from "./views/TaskChuteView"
import DayStateService from "./services/DayStateService"
import { TaskChuteSettingTab } from "./ui/SettingsTab"
import { initializeLocaleManager, onLocaleChange, t } from "./i18n"

const VIEW_TYPE_TASKCHUTE = "taskchute-view"

type LocalizedCommandDefinition = {
  id: string
  nameKey: string
  fallback: string
  callback: () => void | Promise<void>
}

export default class TaskChutePlusPlugin extends Plugin {
  settings!: TaskChuteSettings
  pathManager!: PathManager
  routineAliasManager!: RoutineAliasManager
  dayStateService!: DayStateService
  globalTimerInterval?: ReturnType<typeof setInterval> | null
  private localizedCommands: LocalizedCommandDefinition[] = []
  private unregisterLocaleListener?: () => void
  private ribbonIconEl?: HTMLElement

  // Simple logger/notification wrapper
  _log(level: keyof Console | undefined, ...args: unknown[]): void {
    try {
      if (level === 'warn') {
        console.warn(...args);
      } else if (level === 'error') {
        console.error(...args);
      } else {
        console.debug(...args);
      }
    } catch {
      // Ignore logging errors in production builds
    }
  }

  _notify(message: string, timeout?: number): void {
    try {
      new Notice(message, timeout);
    } catch (error) {
      this._log('warn', '[Notice]', message, error);
    }
  }

  private registerRibbon(): void {
    const label = t("commands.openView", "Open TaskChute")
    this.ribbonIconEl = this.addRibbonIcon("checkmark", label, () => {
      this.activateTaskChuteView()
    })
    this.updateRibbonLabel()
  }

  private translateCommand(def: LocalizedCommandDefinition): string {
    return t(def.nameKey, def.fallback)
  }

  private registerLocalizedCommand(def: LocalizedCommandDefinition): void {
    const alreadyRegistered = this.localizedCommands.some(
      (existing) => existing.id === def.id,
    )
    if (!alreadyRegistered) {
      this.localizedCommands.push(def)
    }
    this.addCommand({
      id: def.id,
      name: this.translateCommand(def),
      callback: def.callback,
    })
  }

  private refreshLocalizedCommands(): void {
    const baseId = this.manifest.id
    for (const def of this.localizedCommands) {
      try {
        this.app.commands.removeCommand(`${baseId}:${def.id}`)
      } catch (error) {
        this._log?.('warn', 'Failed to remove command for relocalization', error)
      }
      this.addCommand({
        id: def.id,
        name: this.translateCommand(def),
        callback: def.callback,
      })
    }
  }

  private updateRibbonLabel(): void {
    if (!this.ribbonIconEl) return
    const label = t("commands.openView", "Open TaskChute")
    const ribbon = this.ribbonIconEl as HTMLElement & {
      setAttr?: (key: string, value: string) => void
    }
    if (typeof ribbon.setAttr === "function") {
      ribbon.setAttr("aria-label", label)
      ribbon.setAttr("aria-label-position", "right")
      ribbon.setAttr("data-tooltip", label)
    } else {
      ribbon.setAttribute("aria-label", label)
      ribbon.setAttribute("data-tooltip", label)
    }
    ribbon.setAttribute("title", label)
  }

  private handleLocaleChange(): void {
    this.refreshLocalizedCommands()
    this.updateRibbonLabel()
    const view = this.getTaskChuteView()
    if (
      view &&
      typeof (view as Partial<TaskChuteView> & { applyLocale?: () => void }).applyLocale ===
        "function"
    ) {
      try {
        ;(view as TaskChuteView & { applyLocale: () => void }).applyLocale()
      } catch (error) {
        this._log?.("warn", "Failed to apply locale to TaskChuteView", error)
      }
    }
  }

  async onload(): Promise<void> {
    // Load settings with defaults
    const loaded = (await this.loadData()) || {}
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded)
    if (!this.settings.slotKeys) this.settings.slotKeys = {}
    if (typeof this.settings.useOrderBasedSort !== "boolean") {
      this.settings.useOrderBasedSort = true
    }
    if (!this.settings.languageOverride) {
      this.settings.languageOverride = "auto"
    }

    initializeLocaleManager(this.settings.languageOverride)
    this.unregisterLocaleListener = onLocaleChange(() => {
      this.handleLocaleChange()
    })

    // Initialize PathManager
    this.pathManager = new PathManager(this)

    // Initialize DayStateService
    this.dayStateService = new DayStateService(this)

    // Initialize RoutineAliasManager
    this.routineAliasManager = new RoutineAliasManager(this)
    await this.routineAliasManager.loadAliases()

    // Create required folders on first startup
    await this.ensureRequiredFolders()

    // Add settings tab if available
    try {
      this.addSettingTab(new TaskChuteSettingTab(this.app, this))
    } catch (error) {
      this._log("warn", "Settings tab not available:", error)
    }

    // Register view type
    this.registerView(
      VIEW_TYPE_TASKCHUTE,
      (leaf) => new TaskChuteView(leaf, this),
    )

    // Add ribbon icon
    this.registerRibbon()

    // Register commands
    this.registerCommands()

    // Apply initial locale-dependent UI updates
    this.handleLocaleChange()
  }

  async onunload(): Promise<void> {
    // Clear timer intervals
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    if (this.unregisterLocaleListener) {
      this.unregisterLocaleListener()
      this.unregisterLocaleListener = undefined
    }

    // Clear boundary check timeout
    const view = this.getTaskChuteView()
    if (view && view.boundaryCheckTimeout) {
      clearTimeout(view.boundaryCheckTimeout)
      view.boundaryCheckTimeout = null
    }

    // Clean up views
    this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE).forEach((leaf) => {
      if (leaf.view && leaf.view.onunload) {
        leaf.view.onunload()
      }
    })
  }

  private registerCommands(): void {
    this.registerLocalizedCommand({
      id: "open-taskchute-view",
      nameKey: "commands.openView",
      fallback: "Open TaskChute",
      callback: () => {
        this.activateTaskChuteView()
      },
    })

    this.registerLocalizedCommand({
      id: "taskchute-settings",
      nameKey: "commands.openSettings",
      fallback: "TaskChute settings",
      callback: () => {
        this.showSettingsModal()
      },
    })

    this.registerLocalizedCommand({
      id: "duplicate-selected-task",
      nameKey: "commands.duplicateSelected",
      fallback: "Duplicate selected task",
      callback: async () => {
        await this.triggerDuplicateSelectedTask()
      },
    })

    this.registerLocalizedCommand({
      id: "delete-selected-task",
      nameKey: "commands.deleteSelected",
      fallback: "Delete selected task",
      callback: async () => {
        await this.triggerDeleteSelectedTask()
      },
    })

    this.registerLocalizedCommand({
      id: "reset-selected-task",
      nameKey: "commands.resetSelected",
      fallback: "Reset selected task",
      callback: async () => {
        await this.triggerResetSelectedTask()
      },
    })

    this.registerLocalizedCommand({
      id: "show-today-tasks",
      nameKey: "commands.showToday",
      fallback: "Show today's tasks",
      callback: async () => {
        await this.triggerShowTodayTasks()
      },
    })

    this.registerLocalizedCommand({
      id: "reorganize-idle-tasks",
      nameKey: "commands.reorganizeIdle",
      fallback: "Reorganize idle tasks to current slot",
      callback: () => {
        const view = this.getTaskChuteView()
        if (view) {
          view.reorganizeIdleTasks()
        } else {
          new Notice(t("notices.viewNotOpen", "TaskChute view is not open"))
        }
      },
    })
  }

  async ensureRequiredFolders(): Promise<void> {
    const targets: Array<{
      labelKey: string
      fallback: string
      getter: () => string
    }> = [
      {
        labelKey: "paths.taskFolder",
        fallback: "Task folder",
        getter: () => this.pathManager.getTaskFolderPath(),
      },
      {
        labelKey: "paths.projectFolder",
        fallback: "Project folder",
        getter: () => this.pathManager.getProjectFolderPath(),
      },
      {
        labelKey: "paths.logDataFolder",
        fallback: "Log data folder",
        getter: () => this.pathManager.getLogDataPath(),
      },
      {
        labelKey: "paths.reviewDataFolder",
        fallback: "Review data folder",
        getter: () => this.pathManager.getReviewDataPath(),
      },
    ]

    for (const target of targets) {
      const label = t(target.labelKey, target.fallback)
      try {
        const path = target.getter()
        await this.pathManager.ensureFolderExists(path)
      } catch {
        try {
          new Notice(
            t(
              "notices.folderCreationFailed",
              "Failed to create {label}",
              { label },
            ),
          )
        } catch {
          // Ignore if Notice is not available (e.g., in tests)
        }
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  getTaskChuteView(): TaskChuteView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)[0]
    if (!leaf || !leaf.view) return null
    // Avoid instanceof to prevent identity issues across reloads/bundles
    try {
      const candidate = leaf.view as Partial<TaskChuteView> & {
        getViewType?: () => string
      }

      if (
        candidate &&
        typeof candidate.getViewType === "function" &&
        candidate.getViewType() === VIEW_TYPE_TASKCHUTE
      ) {
        return candidate as TaskChuteView
      }
    } catch {
      // Ignore legacy view instances that may not expose getViewType
    }
    return null
  }

  // Ensure we have a fresh (current code) view instance.
  // If missing or missing required methods, detach and reopen.
  private async getOrCreateTaskChuteView(
    requiredMethods: Array<keyof TaskChuteView> = [],
  ): Promise<TaskChuteView | null> {
    let view = this.getTaskChuteView()
    const hasAll = (candidate: TaskChuteView | null): candidate is TaskChuteView =>
      Boolean(
        candidate &&
          requiredMethods.every(
            (method) => typeof candidate[method] === "function",
          ),
      )

    if (hasAll(view)) return view

    // Recreate view to avoid stale (pre-refactor) instances lingering across reloads
    try {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASKCHUTE)
    } catch {
      // Ignore workspace detach failures (e.g., during tests)
    }

    await this.activateTaskChuteView()

    // Wait a tick to ensure view is constructed
    await new Promise((r) => setTimeout(r, 50))

    view = this.getTaskChuteView()
    if (hasAll(view)) return view
    return view // return whatever we have; caller can still fallback
  }

  // Command bridges with back-compat/fallbacks
  private async triggerShowTodayTasks(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["showTodayTasks"])
    if (!view) {
      await this.activateTaskChuteView()
      return
    }

    view.showTodayTasks()
  }

  private async triggerDuplicateSelectedTask(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["duplicateSelectedTask"])
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"))
      return
    }
    await view.duplicateSelectedTask()
  }

  private async triggerDeleteSelectedTask(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["deleteSelectedTask"])
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"))
      return
    }
    view.deleteSelectedTask()
  }

  private async triggerResetSelectedTask(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["resetSelectedTask"])
    if (!view) {
      new Notice(t("notices.viewNotOpen", "TaskChute view is not open"))
      return
    }
    await view.resetSelectedTask()
  }



  async activateTaskChuteView(): Promise<void> {
    const { workspace } = this.app
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)
    
    if (leaves.length > 0) {
      // 既存のタブがあればフォーカスを当てるだけ
      await workspace.revealLeaf(leaves[0])
      return
    }
    
    // なければ新規作成
    const leaf = workspace.getLeaf(false) // false: 既存のタブグループを再利用
    await leaf.setViewState({
      type: VIEW_TYPE_TASKCHUTE,
      active: true,
    })
    await workspace.revealLeaf(leaf)
  }

  showSettingsModal(): void {
    // Create modal overlay
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // Modal header
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", {
      text: t("commands.openSettings", "TaskChute settings"),
    })

    // Close button
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: t("common.close", "Close") },
    })

    // Form container
    const form = modalContent.createEl("form", { cls: "task-form" })

    // Path settings section
    const pathSection = form.createEl("div", { cls: "settings-section" })
    pathSection.createEl("h4", {
      text: t("settings.heading", "Path settings"),
    })

    // Task folder path
    this.createPathSetting(
      pathSection,
      t("settings.taskFolder.name", "Task folder path"),
      "taskFolderPath",
      PathManager.DEFAULT_PATHS.taskFolder,
    )

    // Project folder path
    this.createPathSetting(
      pathSection,
      t("settings.projectFolder.name", "Project folder path"),
      "projectFolderPath",
      PathManager.DEFAULT_PATHS.projectFolder,
    )

    // Log data path
    this.createPathSetting(
      pathSection,
      t("settings.logDataFolder.name", "Log data path"),
      "logDataPath",
      PathManager.DEFAULT_PATHS.logData,
    )

    // Review data path
    this.createPathSetting(
      pathSection,
      t("settings.reviewDataFolder.name", "Review data path"),
      "reviewDataPath",
      PathManager.DEFAULT_PATHS.reviewData,
    )

    // Event listeners
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal)
      }
    })

    // Add to DOM
    document.body.appendChild(modal)
  }

  private createPathSetting(
    container: HTMLElement,
    label: string,
    settingKey: keyof TaskChuteSettings,
    placeholder: string,
  ): void {
    const group = container.createEl("div", { cls: "form-group" })
    group.createEl("label", { text: label + ":", cls: "form-label" })
    const input = group.createEl("input", {
      type: "text",
      cls: "form-input",
      attr: { placeholder },
    }) as HTMLInputElement

    input.value = (this.settings[settingKey] as string) || ""

    input.addEventListener("change", async () => {
      const value = input.value.trim()
      const validation = this.pathManager.validatePath(value)

      if (validation.valid || value === "") {
        ;(this.settings[settingKey] as string) = value
        await this.saveSettings()

        // Try to create folder
        try {
          if (settingKey === "taskFolderPath") {
            await this.pathManager.ensureFolderExists(
              this.pathManager.getTaskFolderPath(),
            )
          } else if (settingKey === "projectFolderPath") {
            await this.pathManager.ensureFolderExists(
              this.pathManager.getProjectFolderPath(),
            )
          } else if (settingKey === "logDataPath") {
            await this.pathManager.ensureFolderExists(
              this.pathManager.getLogDataPath(),
            )
          } else if (settingKey === "reviewDataPath") {
            await this.pathManager.ensureFolderExists(
              this.pathManager.getReviewDataPath(),
            )
          }
        } catch {
          // Ignore folder creation errors
        }
      } else {
        new Notice(
          validation.error ||
            t('settings.validation.invalidPath', 'Invalid path'),
        )
        input.value = (this.settings[settingKey] as string) || ""
      }
    })
  }
}
