import { Notice, Plugin } from "obsidian"

import { TaskChuteSettings } from "./types"
import { DEFAULT_SETTINGS } from "./settings"
import { PathManager } from "./managers/PathManager"
import { RoutineAliasManager } from "./managers/RoutineAliasManager"
import { TaskChuteView } from "./views/TaskChuteView"
import DayStateService from "./services/DayStateService"
import { TaskChuteSettingTab } from "./ui/SettingsTab"

const VIEW_TYPE_TASKCHUTE = "taskchute-view"

export default class TaskChutePlusPlugin extends Plugin {
  settings!: TaskChuteSettings
  pathManager!: PathManager
  routineAliasManager!: RoutineAliasManager
  dayStateService!: DayStateService
  globalTimerInterval?: ReturnType<typeof setInterval> | null

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

  async onload(): Promise<void> {
    // Load settings with defaults
    const loaded = (await this.loadData()) || {}
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded)
    if (!this.settings.slotKeys) this.settings.slotKeys = {}
    if (typeof this.settings.useOrderBasedSort !== "boolean") {
      this.settings.useOrderBasedSort = true
    }

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
    this.addRibbonIcon("checkmark", "TaskChuteを開く", () => {
      this.activateTaskChuteView()
    })

    // Register commands
    this.registerCommands()
  }

  async onunload(): Promise<void> {
    // Clear timer intervals
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
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
    // Main TaskChute command
    this.addCommand({
      id: "open-taskchute-view",
      name: "TaskChuteを開く",
      callback: () => {
        this.activateTaskChuteView()
      },
    })

    // Settings command
    this.addCommand({
      id: "taskchute-settings",
      name: "TaskChute設定",
      callback: () => {
        this.showSettingsModal()
      },
    })

    // Task manipulation commands
    this.addCommand({
      id: "duplicate-selected-task",
      name: "選択されたタスクを複製",
      // ホットキーはデフォルトで設定しない
      callback: async () => {
        await this.triggerDuplicateSelectedTask()
      },
    })

    this.addCommand({
      id: "delete-selected-task",
      name: "選択されたタスクを削除",
      // ホットキーはデフォルトで設定しない
      callback: async () => {
        await this.triggerDeleteSelectedTask()
      },
    })

    this.addCommand({
      id: "reset-selected-task",
      name: "選択されたタスクを未実行に戻す",
      callback: async () => {
        await this.triggerResetSelectedTask()
      },
    })

    // Today's tasks command
    this.addCommand({
      id: "show-today-tasks",
      name: "今日のタスクを表示",
      callback: async () => {
        await this.triggerShowTodayTasks()
      },
    })

    // Reorganize idle tasks command
    this.addCommand({
      id: "reorganize-idle-tasks",
      name: "未実行タスクを現在の時間帯に整理",
      callback: () => {
        const view = this.getTaskChuteView()
        if (view) {
          view.reorganizeIdleTasks()
        } else {
          new Notice("TaskChuteビューが開かれていません")
        }
      },
    })


  }

  async ensureRequiredFolders(): Promise<void> {
    const targets: [string, () => string][] = [
      ["タスクフォルダ", () => this.pathManager.getTaskFolderPath()],
      ["プロジェクトフォルダ", () => this.pathManager.getProjectFolderPath()],
      ["ログデータフォルダ", () => this.pathManager.getLogDataPath()],
      ["レビューデータフォルダ", () => this.pathManager.getReviewDataPath()],
    ]

    for (const [label, getter] of targets) {
      try {
        const path = getter()
        await this.pathManager.ensureFolderExists(path)
      } catch {
        try {
          new Notice(`${label}の作成に失敗しました`)
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
      new Notice("TaskChuteビューが開かれていません")
      return
    }
    await view.duplicateSelectedTask()
  }

  private async triggerDeleteSelectedTask(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["deleteSelectedTask"])
    if (!view) {
      new Notice("TaskChuteビューが開かれていません")
      return
    }
    view.deleteSelectedTask()
  }

  private async triggerResetSelectedTask(): Promise<void> {
    const view = await this.getOrCreateTaskChuteView(["resetSelectedTask"])
    if (!view) {
      new Notice("TaskChuteビューが開かれていません")
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
    modalHeader.createEl("h3", { text: "TaskChute設定" })

    // Close button
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // Form container
    const form = modalContent.createEl("form", { cls: "task-form" })

    // Path settings section
    const pathSection = form.createEl("div", { cls: "settings-section" })
    pathSection.createEl("h4", { text: "パス設定" })

    // Task folder path
    this.createPathSetting(
      pathSection,
      "タスクフォルダパス",
      "taskFolderPath",
      PathManager.DEFAULT_PATHS.taskFolder,
    )

    // Project folder path
    this.createPathSetting(
      pathSection,
      "プロジェクトフォルダパス",
      "projectFolderPath",
      PathManager.DEFAULT_PATHS.projectFolder,
    )

    // Log data path
    this.createPathSetting(
      pathSection,
      "ログデータパス",
      "logDataPath",
      PathManager.DEFAULT_PATHS.logData,
    )

    // Review data path
    this.createPathSetting(
      pathSection,
      "レビューデータパス",
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
        new Notice(validation.error!)
        input.value = (this.settings[settingKey] as string) || ""
      }
    })
  }
}
