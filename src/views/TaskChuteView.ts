import { ItemView, WorkspaceLeaf, TFile, Notice } from "obsidian"
import {
  calculateNextBoundary,
  getCurrentTimeSlot,
  getSlotFromTime,
  TimeBoundary,
} from "../utils/time"
import { LogView } from "./LogView"
import RoutineManagerModal from "../ui/RoutineManagerModal"
import TaskMoveCalendar from "../ui/TaskMoveCalendar"
import { ReviewService } from "../services/ReviewService"
import { HeatmapService } from "../services/HeatmapService"
import {
  TaskData,
  TaskInstance,
  DeletedInstance,
  HiddenRoutine,
  NavigationState,
  TaskNameValidator,
  AutocompleteInstance,
  DayState,
  TaskChutePluginLike,
  RoutineFrontmatter,
} from "../types"
import { TimerService } from "../services/TimerService"
import { loadTasksRefactored } from "./TaskChuteView.helpers"
import { ProjectNoteSyncManager } from "../managers/ProjectNoteSyncManager"
import { RunningTasksService } from "../services/RunningTasksService"
import { ExecutionLogService } from "../services/ExecutionLogService"
import { TaskCreationService } from "../services/TaskCreationService"
import { TaskNameAutocomplete } from "../ui/TaskNameAutocomplete"
import { TaskValidator } from "../services/TaskValidator"
import { applyRoutineFrontmatterMerge } from "../services/RoutineFrontmatterUtils"
import { getScheduledTime, setScheduledTime } from "../utils/fieldMigration"
import { deriveRoutineModalTitle, deriveWeeklySelection, deriveMonthlySelection } from "./routineModal.helpers"
import { computeExecutionInstanceKey } from "../utils/logKeys"
import { getCurrentLocale, t } from "../i18n"

// VIEW_TYPE_TASKCHUTE is defined in main.ts

class NavigationStateManager implements NavigationState {
  selectedSection: "routine" | "review" | "log" | "project" | null = null
  isOpen: boolean = false
}

type NavigationSectionKey = Exclude<
  NavigationStateManager["selectedSection"],
  null
>

type TaskLogEntry = {
  instanceId?: string
  executionComment?: string
  focusLevel?: number
  energyLevel?: number
  taskPath?: string
  taskName?: string
  taskTitle?: string
  durationSec?: number
  duration?: number
  startTime?: string
  stopTime?: string
  isCompleted?: boolean
  [key: string]: unknown
}

type TaskLogSnapshot = {
  taskExecutions: Record<string, TaskLogEntry[]>
  dailySummary: Record<string, Record<string, unknown>>
}

type RoutineTaskShape = Pick<
  TaskData,
  "path" | "isRoutine" | "scheduledTime"
> & {
  title?: string
  routine_type?: string
  routine_interval?: number
  routine_enabled?: boolean
  weekdays?: number[]
  weekday?: number
  monthly_week?: number | "last"
  monthly_weekday?: number
  開始時刻?: string
  projectPath?: string
  projectTitle?: string
}

export class TaskChuteView extends ItemView {
  // Core Properties
  private plugin: TaskChutePluginLike
  private tasks: TaskData[] = []
  private taskInstances: TaskInstance[] = []
  private currentInstance: TaskInstance | null = null
  private globalTimerInterval: ReturnType<typeof setInterval> | null = null
  private timerService: TimerService | null = null
  private logView: LogView | null = null
  private runningTasksService: RunningTasksService
  private executionLogService: ExecutionLogService
  private taskCreationService: TaskCreationService

  // Date Navigation
  private currentDate: Date

  // UI Elements
  private taskList: HTMLElement
  private navigationPanel: HTMLElement
  private navigationOverlay: HTMLElement
  private navigationContent: HTMLElement

  // State Management
  private useOrderBasedSort: boolean
  private navigationState: NavigationStateManager
  private selectedTaskInstance: TaskInstance | null = null
  private autocompleteInstances: AutocompleteInstance[] = []
  private dayStateCache: Map<string, DayState> = new Map()
  private currentDayState: DayState | null = null
  private currentDayStateKey: string | null = null

  // Boundary Check (idle-task-auto-move feature)
  private boundaryCheckTimeout: ReturnType<typeof setTimeout> | null = null

  // Debounce Timer
  private renderDebounceTimer: ReturnType<typeof setTimeout> | null = null

  // Debug helper flag
  // Task Name Validator
  private TaskNameValidator: TaskNameValidator = {
    INVALID_CHARS_PATTERN: new RegExp("[:|/\\#^]", "g"),

    validate(taskName: string) {
      const invalidChars = taskName.match(this.INVALID_CHARS_PATTERN)
      return {
        isValid: !invalidChars,
        invalidChars: invalidChars ? [...new Set(invalidChars)] : [],
      }
    },

    getErrorMessage(invalidChars: string[]) {
      return t(
        "taskChuteView.validator.invalidChars",
        `Task name contains invalid characters: ${invalidChars.join(", ")}`,
        { chars: invalidChars.join(", ") },
      )
    },
  }

  public getTaskNameValidator(): TaskNameValidator {
    return this.TaskNameValidator
  }

  private tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`taskChuteView.${key}`, fallback, vars)
  }

  private getWeekdayNames(): string[] {
    const locale = getCurrentLocale()
    if (locale === "ja") {
      return [
        this.tv("labels.weekdays.sunday", "Sun"),
        this.tv("labels.weekdays.monday", "Mon"),
        this.tv("labels.weekdays.tuesday", "Tue"),
        this.tv("labels.weekdays.wednesday", "Wed"),
        this.tv("labels.weekdays.thursday", "Thu"),
        this.tv("labels.weekdays.friday", "Fri"),
        this.tv("labels.weekdays.saturday", "Sat"),
      ]
    }
    return [
      this.tv("labels.weekdays.sundayShort", "Sun"),
      this.tv("labels.weekdays.mondayShort", "Mon"),
      this.tv("labels.weekdays.tuesdayShort", "Tue"),
      this.tv("labels.weekdays.wednesdayShort", "Wed"),
      this.tv("labels.weekdays.thursdayShort", "Thu"),
      this.tv("labels.weekdays.fridayShort", "Fri"),
      this.tv("labels.weekdays.saturdayShort", "Sat"),
    ]
  }

  constructor(leaf: WorkspaceLeaf, plugin: TaskChutePluginLike) {
    super(leaf)
    this.plugin = plugin

    // Initialize current date
    const today = new Date()
    this.currentDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    )

    // Initialize sort preference
    this.useOrderBasedSort = this.plugin.settings.useOrderBasedSort !== false

    // Initialize navigation state
    this.navigationState = new NavigationStateManager()

    // Services
    this.runningTasksService = new RunningTasksService(this.plugin)
    this.executionLogService = new ExecutionLogService(this.plugin)
    this.taskCreationService = new TaskCreationService(this.plugin)
  }

  private getInstanceDisplayTitle(inst: TaskInstance): string {
    const candidates = [inst.task.displayTitle, inst.executedTitle, inst.task.name]
    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        const trimmed = candidate.trim()
        if (trimmed.length > 0) {
          return trimmed
        }
      }
    }
    return this.tv("status.unassignedTask", "Unassigned task")
  }

  getViewType(): string {
    return "taskchute-view"
  }

  getDisplayText(): string {
    return "TaskChute"
  }

  getIcon(): string {
    return "checkmark"
  }

  // ===========================================
  // Core Lifecycle Methods
  // ===========================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement
    container.empty()

    // Schedule boundary check for idle-task-auto-move
    this.scheduleBoundaryCheck()

    await this.setupUI(container)
    await this.loadTasks()
    // Apply boundary check immediately on open (today only)
    this.checkBoundaryTasks()

    // Restore any running tasks from persistence
    await this.restoreRunningTaskState()

    // Styles are now provided via styles.css (no dynamic CSS injection)
    // Initialize timer service (ticks update timer displays)
    this.ensureTimerService()
    this.setupResizeObserver()
    this.initializeNavigationEventListeners()
    this.setupEventListeners()
  }

  async onClose(): Promise<void> {
    if (this.activeMoveCalendar) {
      this.activeMoveCalendar.close()
      this.activeMoveCalendar = null
    }
    // Clean up autocomplete instances
    this.cleanupAutocompleteInstances()

    // Clean up timers
    this.cleanupTimers()
  }

  // ===========================================
  // UI Setup Methods
  // ===========================================

  private async setupUI(container: HTMLElement): Promise<void> {
    // Top bar container (date navigation and drawer icon)
    const topBarContainer = container.createEl("div", {
      cls: "top-bar-container",
    })

    this.createDrawerToggle(topBarContainer)
    this.createDateNavigation(topBarContainer)
    this.createActionButtons(topBarContainer)

    // Main container
    const mainContainer = container.createEl("div", {
      cls: "taskchute-container",
    })

    // Content container for navigation panel and task list
    const contentContainer = mainContainer.createEl("div", {
      cls: "main-container",
    })

    // Navigation overlay and panel
    this.createNavigationUI(contentContainer)

    // Task list container
    const taskListContainer = contentContainer.createEl("div", {
      cls: "task-list-container",
    })

    this.taskList = taskListContainer.createEl("div", { cls: "task-list" })
  }

  private createDrawerToggle(topBarContainer: HTMLElement): void {
    const drawerToggle = topBarContainer.createEl("button", {
      cls: "drawer-toggle",
      attr: {
        title: this.tv("header.openNavigation", "Open navigation"),
        "aria-label": this.tv("header.openNavigation", "Open navigation"),
      },
    })

    drawerToggle.createEl("span", {
      cls: "drawer-toggle-icon",
      text: "☰",
    })
  }

  private createDateNavigation(topBarContainer: HTMLElement): void {
    const navContainer = topBarContainer.createEl("div", {
      cls: "date-nav-container compact",
    })

    const leftBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: "<",
    })

    const calendarBtn = navContainer.createEl("button", {
      cls: "calendar-btn",
      text: "🗓️",
      attr: {
        title: this.tv("header.openCalendar", "Open calendar"),
        "aria-label": this.tv("header.openCalendar", "Open calendar"),
      },
      style:
        "font-size:18px;padding:0 6px;background:none;border:none;cursor:pointer;",
    })

    const dateLabel = navContainer.createEl("span", { cls: "date-nav-label" })

    const rightBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: ">",
    })

    // Update date label
    this.updateDateLabel(dateLabel)

    // Event listeners
    leftBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() - 1)
      this.updateDateLabel(dateLabel)
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
    })

    rightBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() + 1)
      this.updateDateLabel(dateLabel)
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
    })

    // Calendar button functionality
    this.setupCalendarButton(calendarBtn, dateLabel)

    // Divider
    topBarContainer.createEl("div", {
      cls: "header-divider",
    })
  }

  private createActionButtons(topBarContainer: HTMLElement): void {
    const actionSection = topBarContainer.createEl("div", {
      cls: "header-action-section",
    })

    const addTaskButton = actionSection.createEl("button", {
      cls: "add-task-button repositioned",
      text: "+",
      attr: {
        title: this.tv("header.addTask", "Add new task"),
        "aria-label": this.tv("header.addTask", "Add new task"),
      },
    })

    const robotButton = actionSection.createEl("button", {
      cls: "robot-terminal-button",
      text: "🤖",
      attr: {
        title: this.tv("header.openTerminal", "Open terminal"),
        "aria-label": this.tv("header.openTerminal", "Open terminal"),
      },
    })

    // Event listeners
    addTaskButton.addEventListener("click", () => this.showAddTaskModal())
    robotButton.addEventListener("click", async () => {
      try {
        await this.app.commands.executeCommandById(
          "terminal:open-terminal.integrated.root",
        )
      } catch (error) {
        const message = this.tv(
          "header.terminalOpenFailed",
          "Failed to open terminal: {message}",
          { message: error instanceof Error ? error.message : String(error) },
        )
        new Notice(message)
      }
    })
  }

  // Utility: reload tasks and immediately restore running-state from persistence
  private async reloadTasksAndRestore(
    options: { runBoundaryCheck?: boolean } = {},
  ): Promise<void> {
    await this.loadTasks()
    await this.restoreRunningTaskState()
    // Re-render to reflect restored running instances
    this.renderTaskList()
    if (options.runBoundaryCheck) {
      await this.checkBoundaryTasks()
    }
    this.scheduleBoundaryCheck()
  }

  private createNavigationUI(contentContainer: HTMLElement): void {
    // Overlay for click outside to close
    this.navigationOverlay = contentContainer.createEl("div", {
      cls: "navigation-overlay navigation-overlay-hidden",
    })

    // Navigation Panel
    this.navigationPanel = contentContainer.createEl("div", {
      cls: "navigation-panel navigation-panel-hidden",
    })

    // Navigation menu
    const navMenu = this.navigationPanel.createEl("nav", {
      cls: "navigation-nav",
    })

    // Content area under the menu
    this.navigationContent = this.navigationPanel.createEl("div", {
      cls: "navigation-content",
    })

    // Navigation items
    const navigationItems: Array<{
      key: NavigationSectionKey
      label: string
      icon: string
    }> = [
      { key: "routine", label: this.tv("navigation.routine", "Routine"), icon: "🔄" },
      { key: "review", label: this.tv("navigation.review", "Review"), icon: "📋" },
      { key: "log", label: this.tv("navigation.log", "Log"), icon: "📊" },
      { key: "project", label: this.tv("navigation.project", "Project"), icon: "📁" },
    ]

    navigationItems.forEach((item) => {
      const navItem = navMenu.createEl("div", {
        cls: "navigation-nav-item",
        attr: { "data-section": item.key },
      })

      navItem.createEl("span", {
        cls: "navigation-nav-icon",
        text: item.icon,
      })

      navItem.createEl("span", {
        cls: "navigation-nav-label",
        text: item.label,
      })

      navItem.addEventListener("click", () => {
        this.handleNavigationItemClick(item.key)
      })
    })
  }

  // ===========================================
  // Date Management Methods
  // ===========================================

  private updateDateLabel(label: HTMLElement): void {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const current = new Date(this.currentDate)
    current.setHours(0, 0, 0, 0)

    const isToday = current.getTime() === today.getTime()
    const localeCode = getCurrentLocale() === "ja" ? "ja-JP" : "en-US"
    const dayName = current.toLocaleDateString(localeCode, { weekday: "short" })
    const dateStr = `${this.currentDate.getMonth() + 1}/${this.currentDate.getDate()}`

    const todayLabel = this.tv("date.today", "Today")
    label.textContent = isToday
      ? `${todayLabel} (${dateStr} ${dayName})`
      : `${dateStr} ${dayName}`
  }

  private getCurrentDateString(): string {
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    return `${y}-${m}-${d}`
  }

  private parseDateString(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map((value) => parseInt(value, 10))
    return new Date(y, (m || 1) - 1, d || 1)
  }

  private async ensureDayStateForDate(dateStr: string): Promise<DayState> {
    const cached = this.dayStateCache.get(dateStr)
    if (cached) {
      if (dateStr === this.getCurrentDateString()) {
        this.currentDayState = cached
        this.currentDayStateKey = dateStr
      }
      return cached
    }
    const date = this.parseDateString(dateStr)
    const loaded = await this.plugin.dayStateService.loadDay(date)
    this.dayStateCache.set(dateStr, loaded)
    if (dateStr === this.getCurrentDateString()) {
      this.currentDayState = loaded
      this.currentDayStateKey = dateStr
    }
    return loaded
  }

  async getDayState(dateStr: string): Promise<DayState> {
    return this.ensureDayStateForDate(dateStr)
  }

  getDayStateSnapshot(dateStr: string): DayState | null {
    return this.dayStateCache.get(dateStr) ?? null
  }

  private async ensureDayStateForCurrentDate(): Promise<DayState> {
    const dateStr = this.getCurrentDateString()
    return this.ensureDayStateForDate(dateStr)
  }

  private getCurrentDayState(): DayState {
    const dateStr = this.getCurrentDateString()
    let state = this.dayStateCache.get(dateStr)
    if (!state) {
      state = {
        hiddenRoutines: [],
        deletedInstances: [],
        duplicatedInstances: [],
        slotOverrides: {},
        orders: {},
      }
      this.dayStateCache.set(dateStr, state)
    }
    this.currentDayState = state
    this.currentDayStateKey = dateStr
    return state
  }

  private async persistDayState(dateStr: string): Promise<void> {
    const state = this.dayStateCache.get(dateStr)
    if (!state) return
    const date = this.parseDateString(dateStr)
    await this.plugin.dayStateService.saveDay(date, state)
  }

  private getOrderKey(inst: TaskInstance): string | null {
    const slot = inst.slotKey || "none"
    const dayState = this.getCurrentDayState()
    const isDuplicate = dayState.duplicatedInstances.some(
      (dup) => dup?.instanceId && dup.instanceId === inst.instanceId,
    )
    if (isDuplicate || !inst.task?.path) {
      return inst.instanceId ? `${inst.instanceId}::${slot}` : null
    }
    if (inst.task?.path) {
      return `${inst.task.path}::${slot}`
    }
    return inst.instanceId ? `${inst.instanceId}::${slot}` : null
  }

  private normalizeState(
    state: TaskInstance["state"],
  ): "done" | "running" | "idle" {
    if (state === "done") return "done"
    if (state === "running" || state === "paused") return "running"
    return "idle"
  }

  private getStatePriority(state: TaskInstance["state"]): number {
    const normalized = this.normalizeState(state)
    if (normalized === "done") return 0
    if (normalized === "running") return 1
    return 2
  }

  private setupCalendarButton(
    calendarBtn: HTMLElement,
    dateLabel: HTMLElement,
  ): void {
    calendarBtn.addEventListener("click", (e) => {
      e.stopPropagation()

      // Remove existing input if any
      const oldInput = document.getElementById("calendar-date-input")
      if (oldInput) oldInput.remove()

      const input = document.createElement("input")
      input.type = "date"
      input.id = "calendar-date-input"
      input.classList.add("taskchute-calendar-input")

      const rect = calendarBtn.getBoundingClientRect()
      input.style.setProperty("--calendar-input-left", `${rect.left}px`)
      input.style.setProperty("--calendar-input-top", `${rect.top - 900}px`)

      // Set current date
      const y = this.currentDate.getFullYear()
      const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
      const d = this.currentDate.getDate().toString().padStart(2, "0")
      input.value = `${y}-${m}-${d}`

      document.body.appendChild(input)

      // Auto-open calendar
      setTimeout(() => {
        try {
          input.focus()
          input.click()

          if (input.showPicker && typeof input.showPicker === "function") {
            input.showPicker()
          } else {
            const mouseEvent = new MouseEvent("mousedown", {
              view: window,
              bubbles: true,
              cancelable: true,
            })
            input.dispatchEvent(mouseEvent)
          }
        } catch {
          // Ignore errors (test environment, etc.)
        }
      }, 50)

      input.addEventListener("change", async () => {
        const [yy, mm, dd] = input.value.split("-").map(Number)
        this.currentDate = new Date(yy, mm - 1, dd)
        this.updateDateLabel(dateLabel)
        await this.reloadTasksAndRestore({ runBoundaryCheck: true })
        input.remove()
      })

      input.addEventListener("blur", () => input.remove())
    })
  }

  // ===========================================
  // Task Loading and Rendering Methods
  // ===========================================

  async loadTasks(): Promise<void> {
    // Use the refactored implementation
    await this.ensureDayStateForCurrentDate()
    await loadTasksRefactored.call(this)
  }

  private async processTaskFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file)
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter

      // Check if it's a task file
      if (!content.includes("#task") && !frontmatter?.estimatedMinutes) {
        return
      }

      const taskData: TaskData = {
        file,
        frontmatter: frontmatter || {},
        path: file.path,
        name: file.basename,
        displayTitle:
          typeof frontmatter?.title === "string" && frontmatter.title.trim().length > 0
            ? frontmatter.title
            : file.basename,
        project: frontmatter?.project,
        isRoutine: frontmatter?.isRoutine === true,
        routine_type: frontmatter?.routine_type,
        routine_start: frontmatter?.routine_start,
        routine_end: frontmatter?.routine_end,
        routine_week: frontmatter?.routine_week,
        routine_day: frontmatter?.routine_day,
        flexible_schedule: frontmatter?.flexible_schedule,
      }

      this.tasks.push(taskData)
    } catch (error) {
      console.error(`Failed to process task file ${file.path}:`, error)
    }
  }

  private async loadTaskInstances(): Promise<void> {
    const dateStr = this.getCurrentDateString()

    for (const task of this.tasks) {
      // Check if task should be shown for current date
      if (!this.shouldShowTaskForDate(task, this.currentDate)) {
        continue
      }

      // Create task instance
      const instance: TaskInstance = {
        task,
        instanceId: this.generateInstanceId(task, dateStr),
        state: "idle",
        slotKey: this.getTaskSlotKey(task),
        date: dateStr,
      }

      // Check if instance is deleted or hidden
      if (
        this.isInstanceDeleted(instance.instanceId, task.path, dateStr) ||
        this.isInstanceHidden(instance.instanceId, task.path, dateStr)
      ) {
        continue
      }

      this.taskInstances.push(instance)
    }
  }

  private shouldShowTaskForDate(task: TaskData, date: Date): boolean {
    // Non-routine tasks are always shown (they will be filtered by instance state)
    if (!task.isRoutine) {
      return true
    }

    // For routine tasks, check schedule
    const dayOfWeek = date.getDay() // 0 = Sunday, 1 = Monday, etc.

    switch (task.routine_type) {
      case "daily":
        return true
      case "weekdays":
        return dayOfWeek >= 1 && dayOfWeek <= 5 // Monday to Friday
      case "weekends":
        return dayOfWeek === 0 || dayOfWeek === 6 // Saturday and Sunday
      case "weekly":
        // Implement weekly logic based on routine_day
        return true // Simplified for now
      case "monthly":
        // Implement monthly logic
        return true // Simplified for now
      default:
        return true
    }
  }

  private generateInstanceId(task: TaskData, dateStr: string): string {
    // Generate a unique ID for this task instance
    return `${task.path}_${dateStr}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`
  }

  private getTaskSlotKey(task: TaskData): string {
    if (task.isRoutine) {
      const dayState = this.getCurrentDayState()
      const override = dayState.slotOverrides?.[task.path]
      if (override) {
        return override
      }
      if (task.scheduledTime) {
        return getSlotFromTime(task.scheduledTime)
      }
      return "none"
    }

    const storedSlot = this.plugin.settings.slotKeys?.[task.path]
    if (storedSlot) {
      return storedSlot
    }
    return "none"
  }

  // ===========================================
  // Task Rendering Methods
  // ===========================================

  renderTaskList(): void {
    // Save scroll position
    const scrollTop = this.taskList.scrollTop
    const scrollLeft = this.taskList.scrollLeft

    // Apply responsive classes
    this.applyResponsiveClasses()

    this.sortTaskInstancesByTimeOrder()
    this.taskList.empty()

    // Group by slot key
    const timeSlots: Record<string, TaskInstance[]> = {}
    this.getTimeSlotKeys().forEach((slot) => {
      timeSlots[slot] = []
    })

    let noTimeInstances: TaskInstance[] = []

    this.taskInstances.forEach((inst) => {
      if (inst.slotKey && inst.slotKey !== "none") {
        // Make sure the slot exists in timeSlots
        if (!timeSlots[inst.slotKey]) {
          timeSlots[inst.slotKey] = []
        }
        timeSlots[inst.slotKey].push(inst)
      } else {
        noTimeInstances.push(inst)
      }
    })

    // Render "no time specified" group first
    this.renderNoTimeGroup(noTimeInstances)

    // Render time slot groups
    this.getTimeSlotKeys().forEach((slot) => {
      const instancesInSlot = timeSlots[slot]
      this.renderTimeSlotGroup(slot, instancesInSlot)
    })

    // Restore scroll position
    this.taskList.scrollTop = scrollTop
    this.taskList.scrollLeft = scrollLeft

    // Update totalTasks count
    this.updateTotalTasksCount()
  }

  private renderNoTimeGroup(instances: TaskInstance[]): void {
    const noTimeHeader = this.taskList.createEl("div", {
      cls: "time-slot-header other",
      text: this.tv("lists.noTime", "No time"),
    })

    this.setupTimeSlotDragHandlers(noTimeHeader, "none")

    // Sort instances by order before rendering
    const sortedInstances = this.sortByOrder(instances)

    sortedInstances.forEach((inst, idx) => {
      this.createTaskInstanceItem(inst, "none", idx)
    })
  }

  private renderTimeSlotGroup(slot: string, instances: TaskInstance[]): void {
    const timeSlotHeader = this.taskList.createEl("div", {
      cls: "time-slot-header",
      text: slot,
    })

    this.setupTimeSlotDragHandlers(timeSlotHeader, slot)

    // Sort instances by order before rendering
    const sortedInstances = this.sortByOrder(instances)

    sortedInstances.forEach((inst, idx) => {
      this.createTaskInstanceItem(inst, slot, idx)
    })
  }

  private createTaskInstanceItem(
    inst: TaskInstance,
    slot: string,
    idx: number,
  ): void {
    const taskItem = this.taskList.createEl("div", { cls: "task-item" })

    // Set data attributes
    if (inst.task.path) {
      taskItem.setAttribute("data-task-path", inst.task.path)
    }
    // Tag each row with instance id to support multiple running instances
    if (inst.instanceId) {
      taskItem.setAttribute("data-instance-id", inst.instanceId)
    }
    taskItem.setAttribute("data-slot", slot || "none")

    // Check if future task
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const viewDate = new Date(this.currentDate)
    viewDate.setHours(0, 0, 0, 0)
    const isFutureTask = viewDate > today

    // Add selection state (disabled to remove background color for running tasks)
    // if (this.currentInstance === inst && inst.state === "running") {
    //   taskItem.classList.add("selected");
    // }

    // Add completion state
    if (inst.state === "done") {
      taskItem.classList.add("completed")
    }

    // 1. Create drag handle (20px)
    this.createDragHandle(taskItem, inst, slot, idx)

    // 2. Create play/stop button (40px)
    this.createPlayStopButton(taskItem, inst, isFutureTask)

    // 3. Create task name (1fr)
    this.createTaskName(taskItem, inst)

    // 4. Create project display (220px)
    this.createProjectDisplay(taskItem, inst)

    // 5. Create time range display (110px)
    this.createTimeRangeDisplay(taskItem, inst)

    // 6. Create duration/timer display (50px)
    this.createDurationTimerDisplay(taskItem, inst)

    // 7. Create comment button (30px)
    this.createCommentButton(taskItem, inst)

    // 8. Create routine button (30px)
    this.createRoutineButton(taskItem, inst)

    // 9. Create settings button (30px)
    this.createSettingsButton(taskItem, inst)

    // Setup event listeners
    this.setupTaskItemEventListeners(taskItem, inst)
  }

  private createDragHandle(
    taskItem: HTMLElement,
    inst: TaskInstance,
    slot: string,
    idx: number,
  ): void {
    const isDraggable = inst.state !== "done"

    const dragHandle = taskItem.createEl("div", {
      cls: "drag-handle",
      attr: isDraggable
        ? {
            draggable: "true",
            title: this.tv("tooltips.dragToMove", "Drag to move"),
          }
        : {
            title: this.tv("tooltips.completedTask", "Completed task"),
          },
    })

    if (!isDraggable) {
      dragHandle.classList.add("disabled")
    }

    // Create grip icon (6 dots)
    const svg = dragHandle.createSvg("svg", {
      attr: {
        width: "10",
        height: "16",
        viewBox: "0 0 10 16",
        fill: "currentColor",
      },
    })

    svg.createSvg("circle", { attr: { cx: "2", cy: "2", r: "1.5" } })
    svg.createSvg("circle", { attr: { cx: "8", cy: "2", r: "1.5" } })
    svg.createSvg("circle", { attr: { cx: "2", cy: "8", r: "1.5" } })
    svg.createSvg("circle", { attr: { cx: "8", cy: "8", r: "1.5" } })
    svg.createSvg("circle", { attr: { cx: "2", cy: "14", r: "1.5" } })
    svg.createSvg("circle", { attr: { cx: "8", cy: "14", r: "1.5" } })

    // Setup drag events
    if (isDraggable) {
      this.setupDragEvents(dragHandle, taskItem, slot, idx)
    }

    // Click handler for selection
    dragHandle.addEventListener("click", (e) => {
      e.stopPropagation()
      this.selectTaskForKeyboard(inst, taskItem)
    })
  }

  private createPlayStopButton(
    taskItem: HTMLElement,
    inst: TaskInstance,
    isFutureTask: boolean,
  ): void {
    let btnCls = "play-stop-button"
    let btnText = "▶️"
    let btnTitle = this.tv("buttons.start", "Start")

    if (isFutureTask) {
      btnCls += " future-task-button"
      btnText = "—"
      btnTitle = this.tv("notices.futureTaskPrevented", "Cannot start future tasks")
    } else if (inst.state === "running") {
      btnCls += " stop"
      btnText = "⏹"
      btnTitle = this.tv("buttons.stop", "Stop")
    } else if (inst.state === "done") {
      btnText = "☑️"
      btnTitle = this.tv("buttons.remeasureCompleted", "Re-measure completed task")
    }

    const playButton = taskItem.createEl("button", {
      cls: btnCls,
      text: btnText,
      attr: { title: btnTitle },
    })

    if (isFutureTask) {
      playButton.disabled = true
    }

    playButton.addEventListener("click", async (e) => {
      e.stopPropagation()
      if (isFutureTask) {
        new Notice(
          this.tv(
            "notices.futureTaskPreventedWithPeriod",
            "Cannot start a future task.",
          ),
          2000,
        )
        return
      }

      if (inst.state === "running") {
        await this.stopInstance(inst)
      } else if (inst.state === "idle") {
        await this.startInstance(inst)
      } else if (inst.state === "done") {
        // Replay functionality for completed tasks
        await this.duplicateAndStartInstance(inst)
      }
    })
  }

  private createTaskName(taskItem: HTMLElement, inst: TaskInstance): void {
    const taskName = taskItem.createEl("span", {
      cls: "task-name",
      text: inst.task.name,
    })

    // Apply same style for all tasks (completed and non-completed)
    taskName.classList.add("task-name--accent")

    // Click handler to open task file
    taskName.addEventListener("click", async (e) => {
      e.stopPropagation()
      try {
        await this.app.workspace.openLinkText(inst.task.path, "", false)
      } catch (error) {
        console.error("Failed to open task file", error)
        new Notice(
          this.tv("notices.taskFileOpenFailed", "Failed to open task file"),
        )
      }
    })
  }

  private createTaskNameWithWarning(taskItem: HTMLElement, inst: TaskInstance): void {
    const container = taskItem.createEl("div", { cls: "task-name-container" });

    // Check for warnings
    const validation = TaskValidator.validate(inst.task.frontmatter || {});

    // Add warning icon if there are warnings
    if (validation.warnings.length > 0) {
      const highSeverityWarning = validation.warnings.find(w => w.severity === 'high');
      const warningToShow = highSeverityWarning || validation.warnings[0];

      const warningIcon = container.createEl("span", {
        cls: `task-warning-icon ${warningToShow.severity === 'high' ? 'warning-high' : ''}`,
        text: "⚠️",
        attr: {
          'aria-label': warningToShow.message,
          'title': `${warningToShow.message}\n${warningToShow.suggestion || ''}`
        }
      });

      // Add tooltip behavior
      warningIcon.addEventListener("mouseenter", () => {
        const tooltip = document.body.createEl("div", {
          cls: "task-warning-tooltip",
          text: `${warningToShow.message}\n${warningToShow.suggestion || ''}`
        });

        const rect = warningIcon.getBoundingClientRect();
        tooltip.setAttr('style', `position: absolute; left: ${rect.left}px; top: ${rect.bottom + 5}px; z-index: 1000;`);

        warningIcon.addEventListener("mouseleave", () => {
          tooltip.remove();
        }, { once: true });
      });
    }

    // Create task name
    const taskName = container.createEl("span", {
      cls: "task-name",
      text: inst.task.name,
    });

    // Apply same style for all tasks (completed and non-completed)
    taskName.classList.add("task-name--accent");

    // Click handler to open task file
    taskName.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await this.app.workspace.openLinkText(inst.task.path, "", false);
      } catch (error) {
        console.error("Failed to open task file", error);
        new Notice(
          this.tv("notices.taskFileOpenFailed", "Failed to open task file"),
        );
      }
    });
  }

  private createProjectDisplay(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    const projectDisplay = taskItem.createEl("span", {
      cls: "taskchute-project-display",
    })

    if (inst.task.projectPath && inst.task.projectTitle) {
      // Project button with folder icon and name
      const projectButton = projectDisplay.createEl("span", {
        cls: "taskchute-project-button",
        attr: {
          title: this.tv(
            "project.tooltipAssigned",
            "Project: {title}",
            { title: inst.task.projectTitle },
          ),
        },
      })

      // Folder icon
      projectButton.createEl("span", {
        cls: "taskchute-project-icon",
        text: "📁",
      })

      // Project name (remove "Project - " prefix)
      projectButton.createEl("span", {
        cls: "taskchute-project-name",
        text: inst.task.projectTitle.replace(/^Project\s*-\s*/, ""),
      })

      // Click handler for project
      projectButton.addEventListener("click", async (e) => {
        e.stopPropagation()
        // Open project file or show project modal
        await this.showUnifiedProjectModal(inst)
      })

      // External link icon
      const externalLinkIcon = projectDisplay.createEl("span", {
        cls: "taskchute-external-link",
        text: "🔗",
        attr: { title: this.tv("project.openNote", "Open project note") },
      })

      externalLinkIcon.addEventListener("click", async (e) => {
        e.stopPropagation()
        // Open project file directly
        await this.openProjectInSplit(inst.task.projectPath)
      })
    } else {
      // プロジェクト未設定の場合（ホバーで表示）
      const projectPlaceholder = projectDisplay.createEl("span", {
        cls: "taskchute-project-placeholder",
        attr: { title: this.tv("project.clickToSet", "Click to set project") },
      })

      projectPlaceholder.addEventListener("click", async (e) => {
        e.stopPropagation()
        await this.showProjectModal(inst)
      })
    }
  }

  private createTimeRangeDisplay(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    const timeRangeEl = taskItem.createEl("span", {
      cls: "task-time-range",
    })

    const formatTime = (date: Date) =>
      date
        ? date.toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : ""

    if (inst.state === "running" && inst.startTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} →`
      // 編集可能にする
      timeRangeEl.classList.add("editable")
      timeRangeEl.addEventListener("click", (e) => {
        e.stopPropagation()
        this.showTimeEditModal(inst)
      })
    } else if (inst.state === "done" && inst.startTime && inst.stopTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} → ${formatTime(
        inst.stopTime,
      )}`
      // 編集可能にする
      timeRangeEl.classList.add("editable")
      timeRangeEl.addEventListener("click", (e) => {
        e.stopPropagation()
        this.showTimeEditModal(inst)
      })
    } else {
      timeRangeEl.textContent = ""
    }
  }

  private createDurationTimerDisplay(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    if (inst.state === "done" && inst.startTime && inst.stopTime) {
      // Completed task: show duration
      const durationEl = taskItem.createEl("span", {
        cls: "task-duration",
      })

      const duration = this.calculateCrossDayDuration(
        inst.startTime,
        inst.stopTime,
      )
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      const durationStr = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}`

      durationEl.textContent = durationStr

      // Add tooltip for cross-day tasks
      if (inst.startTime.getDate() !== inst.stopTime.getDate()) {
        durationEl.setAttribute(
          "title",
          this.tv("tooltips.crossDayTask", "Cross-day task"),
        )
      }
    } else if (inst.state === "running") {
      // Running task: show timer
      const timerEl = taskItem.createEl("span", {
        cls: "task-timer-display",
      })
      this.updateTimerDisplay(timerEl, inst)
    } else {
      // Idle task: show placeholder
      taskItem.createEl("span", {
        cls: "task-duration-placeholder",
      })
    }
  }

  private createCommentButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const commentButton = taskItem.createEl("button", {
      cls: "comment-button",
      text: "💬",
      attr: {
        "data-task-state": inst.state,
      },
    })

    // Enable only for completed tasks
    if (inst.state !== "done") {
      commentButton.classList.add("disabled")
      commentButton.setAttribute("disabled", "true")
    }

    commentButton.addEventListener("click", async (e) => {
      e.stopPropagation()
      if (inst.state !== "done") {
        return
      }
      // Show comment modal for completed tasks
      await this.showTaskCompletionModal(inst)
    })

    // Update comment state based on existing comments
    this.hasCommentData(inst).then((hasComment) => {
      if (hasComment) {
        commentButton.classList.add("active")
      } else {
        commentButton.classList.remove("active")
        if (inst.state === "done") {
          commentButton.classList.add("no-comment")
        }
      }
    })
  }

  private createRoutineButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const routineButton = taskItem.createEl("button", {
      cls: `routine-button ${inst.task.isRoutine ? "active" : ""}`,
      text: "🔄",
      attr: {
        title: inst.task.isRoutine
          ? this.tv('tooltips.routineAssigned', 'Routine task')
          : this.tv('tooltips.routineSet', 'Set as routine'),
      },
    })

    routineButton.addEventListener("click", (e) => {
      e.stopPropagation()
      if (inst.task.isRoutine) {
        this.showRoutineEditModal(inst.task, routineButton)
      } else {
        this.toggleRoutine(inst.task, routineButton)
      }
    })
  }

  private createSettingsButton(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    const settingsButton = taskItem.createEl("button", {
      cls: "settings-task-button",
      text: "⚙️",
      attr: {
        title: this.tv("forms.taskSettings", "Task settings"),
      },
    })

    settingsButton.addEventListener("click", (e) => {
      e.stopPropagation()
      this.showTaskSettingsTooltip(inst, settingsButton)
    })
  }

  // ===========================================
  // Missing Method Placeholders
  // ===========================================

  private async duplicateAndStartInstance(inst: TaskInstance): Promise<void> {
    // Spec: 完了タスクの再生 → 複製して即スタート
    const newInst = await this.duplicateInstance(inst, /*returnOnly*/ true)
    if (!newInst) return
    // 描画更新（複製を反映）
    this.renderTaskList()
    // 即開始
    await this.startInstance(newInst)
    // 最終描画
    this.renderTaskList()
  }

  private async duplicateInstance(
    inst: TaskInstance,
    returnOnly: boolean = false,
  ): Promise<TaskInstance | void> {
    try {
      await this.ensureDayStateForCurrentDate()
      // 新しいインスタンスを作成（元の参照を壊さないよう個別構築）
      const dateStr = this.getCurrentDateString()
      const newInstance: TaskInstance = {
        task: inst.task,
        instanceId: this.generateInstanceId(inst.task, dateStr),
        state: "idle",
        // 重要: 複製は元タスクのスロットの直下に入れる
        slotKey: inst.slotKey,
        originalSlotKey: inst.slotKey,
        startTime: undefined,
        stopTime: undefined,
      }
      // 並び順: 元の直下に入るよう order を調整
      this.calculateDuplicateTaskOrder(newInstance, inst)

      // インスタンスリストに追加
      this.taskInstances.push(newInstance)

      // 当日複製メタデータを保存（復元に使用）
      const dayState = this.getCurrentDayState()
      if (
        !dayState.duplicatedInstances.some(
          (d) => d.instanceId === newInstance.instanceId,
        )
      ) {
        dayState.duplicatedInstances.push({
          instanceId: newInstance.instanceId,
          originalPath: inst.task.path,
          slotKey: newInstance.slotKey,
          originalSlotKey: inst.slotKey,
          timestamp: Date.now(),
        })
        await this.persistDayState(dateStr)
      }

      // UIを更新
      this.renderTaskList()

      new Notice(
        this.tv('notices.taskDuplicated', 'Duplicated "{title}"', {
          title: this.getInstanceDisplayTitle(inst),
        }),
      )

      return returnOnly ? newInstance : undefined
    } catch (error) {
      console.error("Failed to duplicate instance:", error)
      new Notice(this.tv("notices.taskDuplicateFailed", "Failed to duplicate task"))
    }
  }

  // 元直下に挿入されるよう order を計算
  private calculateDuplicateTaskOrder(
    newInst: TaskInstance,
    originalInst: TaskInstance,
  ): void {
    try {
      const slot = originalInst.slotKey || "none"
      const normalizedState = this.normalizeState(originalInst.state)

      const sameState = this.taskInstances.filter(
        (inst) =>
          inst !== newInst &&
          (inst.slotKey || "none") === slot &&
          this.normalizeState(inst.state) === normalizedState,
      )

      const sortedSameState = [...sameState].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      )
      const originalIndex = sortedSameState.indexOf(originalInst)
      const insertIndex =
        originalIndex >= 0 ? originalIndex + 1 : sortedSameState.length

      newInst.slotKey = slot
      newInst.order = this.calculateSimpleOrder(insertIndex, sameState)
    } catch {
      // フォールバック
      newInst.order = (originalInst.order ?? 0) + 100
    }
  }

  private normalizeOrdersForDrag(instances: TaskInstance[]): void {
    if (!instances || instances.length === 0) {
      return
    }

    const sorted = [...instances].sort((a, b) => {
      const orderA = Number.isFinite(a.order)
        ? (a.order as number)
        : Number.MAX_SAFE_INTEGER
      const orderB = Number.isFinite(b.order)
        ? (b.order as number)
        : Number.MAX_SAFE_INTEGER
      if (orderA === orderB) {
        return (a.task?.title || "").localeCompare(b.task?.title || "")
      }
      return orderA - orderB
    })

    let cursor = 100
    sorted.forEach((inst) => {
      inst.order = cursor
      cursor += 100
    })
  }

  private calculateSimpleOrder(
    targetIndex: number,
    sameTasks: TaskInstance[],
  ): number {
    if (!sameTasks || sameTasks.length === 0) {
      return 100
    }

    const working = [...sameTasks]

    // Ensure every task has a finite order before calculation
    const needsSeed = working.some(
      (inst) => !Number.isFinite(inst.order as number),
    )
    if (needsSeed) {
      this.normalizeOrdersForDrag(working)
    }

    const sorted = working.sort(
      (a, b) => (a.order as number) - (b.order as number),
    )
    const clampedIndex = Math.min(Math.max(targetIndex, 0), sorted.length)

    if (clampedIndex <= 0) {
      const firstOrder = sorted[0].order as number
      const result = Number.isFinite(firstOrder) ? firstOrder - 100 : 100
      return result
    }

    if (clampedIndex >= sorted.length) {
      const lastOrder = sorted[sorted.length - 1].order as number
      const result = Number.isFinite(lastOrder)
        ? lastOrder + 100
        : (sorted.length + 1) * 100
      return result
    }

    const prevOrder = sorted[clampedIndex - 1].order as number
    const nextOrder = sorted[clampedIndex].order as number

    if (
      !Number.isFinite(prevOrder) ||
      !Number.isFinite(nextOrder) ||
      nextOrder - prevOrder <= 1
    ) {
      this.normalizeOrdersForDrag(working)
      working.sort((a, b) => (a.order as number) - (b.order as number))
      const normalizedPrev = working[clampedIndex - 1]?.order as number
      const normalizedNext = working[clampedIndex]?.order as number
      return Math.floor(
        ((normalizedPrev ?? 0) +
          (normalizedNext ?? (normalizedPrev ?? 0) + 100)) /
          2,
      )
    }

    return Math.floor((prevOrder + nextOrder) / 2)
  }

  private async showTaskCompletionModal(inst: TaskInstance): Promise<void> {
    const existingComment = await this.getExistingTaskComment(inst)
    const displayTitle = this.getInstanceDisplayTitle(inst)
    const modal = document.createElement("div")
    modal.className = "taskchute-comment-modal"
    const modalContent = modal.createEl("div", {
      cls: "taskchute-comment-content",
    })

    // ヘッダー
    const header = modalContent.createEl("div", {
      cls: "taskchute-modal-header",
    })
    const headerText = existingComment
      ? this.tv('comment.editTitle', `✏️ Edit comment for "${displayTitle}"`, {
          title: displayTitle,
        })
      : this.tv('comment.completedTitle', `🎉 Great job! "${displayTitle}" completed`, {
          title: displayTitle,
        })
    header.createEl("h2", { text: headerText })

    // 実行時間表示（完了タスクのみ）
    if (inst.state === "done" && inst.actualTime) {
      const timeInfo = modalContent.createEl("div", {
        cls: "taskchute-time-info",
      })
      const duration = this.formatTime(inst.actualTime)
      const startTime = inst.startTime
        ? new Date(inst.startTime).toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : ""
      const endTime = inst.stopTime
        ? new Date(inst.stopTime).toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : ""

      timeInfo.createEl("div", {
        text: this.tv('comment.duration', `Duration: ${duration}`, {
          duration,
        }),
        cls: "time-duration",
      })
      if (startTime && endTime) {
        timeInfo.createEl("div", {
        text: this.tv(
          'comment.timeRange',
          `Start: ${startTime} End: ${endTime}`,
          { start: startTime, end: endTime },
        ),
          cls: "time-range",
        })
      }
    }

    // 評価セクション
    const ratingSection = modalContent.createEl("div", {
      cls: "taskchute-rating-section",
    })
    ratingSection.createEl("h3", {
      text: this.tv('comment.question', 'How was this task?'),
    })

    // 集中度
    const focusGroup = ratingSection.createEl("div", { cls: "rating-group" })
    focusGroup.createEl("label", {
      text: this.tv('comment.focusLabel', 'Focus:'),
      cls: "rating-label",
    })
    const initialFocusRating = existingComment?.focusLevel || 0
    const focusRating = focusGroup.createEl("div", {
      cls: "star-rating",
      attr: { "data-rating": initialFocusRating.toString() },
    })
    for (let i = 1; i <= 5; i++) {
      const star = focusRating.createEl("span", {
        cls: `star ${
          i <= initialFocusRating
            ? "taskchute-star-filled"
            : "taskchute-star-empty"
        }`,
        text: "⭐",
      })
      star.addEventListener("click", () => {
        this.setRating(focusRating, i)
      })
      star.addEventListener("mouseenter", () => {
        this.highlightRating(focusRating, i)
      })
      star.addEventListener("mouseleave", () => {
        this.resetRatingHighlight(focusRating)
      })
    }
    // 初期値を表示に反映
    this.updateRatingDisplay(focusRating, initialFocusRating)

    // 元気度
    const energyGroup = ratingSection.createEl("div", { cls: "rating-group" })
    energyGroup.createEl("label", {
      text: this.tv('comment.energyLabel', 'Energy:'),
      cls: "rating-label",
    })
    const initialEnergyRating = existingComment?.energyLevel || 0
    const energyRating = energyGroup.createEl("div", {
      cls: "star-rating",
      attr: { "data-rating": initialEnergyRating.toString() },
    })
    for (let i = 1; i <= 5; i++) {
      const star = energyRating.createEl("span", {
        cls: `star ${
          i <= initialEnergyRating
            ? "taskchute-star-filled"
            : "taskchute-star-empty"
        }`,
        text: "⭐",
      })
      star.addEventListener("click", () => {
        this.setRating(energyRating, i)
      })
      star.addEventListener("mouseenter", () => {
        this.highlightRating(energyRating, i)
      })
      star.addEventListener("mouseleave", () => {
        this.resetRatingHighlight(energyRating)
      })
    }
    // 初期値を表示に反映
    this.updateRatingDisplay(energyRating, initialEnergyRating)

    // コメント入力エリア
    const commentSection = modalContent.createEl("div", {
      cls: "taskchute-comment-section",
    })
    commentSection.createEl("label", {
      text: this.tv('comment.fieldLabel', 'Notes / learnings / improvements:'),
      cls: "comment-label",
    })
    const commentInput = commentSection.createEl("textarea", {
      cls: "taskchute-comment-textarea",
      placeholder: this.tv(
        'comment.placeholder',
        'Share any thoughts, learnings, or improvements for next time...',
      ),
    })
    // ⚠️ 重要：valueプロパティに直接代入（steering documentの指示通り）
    if (existingComment?.executionComment) {
      ;(commentInput as HTMLTextAreaElement).value =
        existingComment.executionComment
    }

    // アクションボタン
    const buttonGroup = modalContent.createEl("div", {
      cls: "taskchute-comment-actions",
    })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "taskchute-button-cancel",
      text: t("common.cancel", "Cancel"),
    })
    const saveButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "taskchute-button-save",
      text: this.tv("buttons.save", "Save"),
    })

    // イベントハンドラ
    const closeModal = () => {
      document.body.removeChild(modal)
    }

    // ESCキーでモーダルを閉じる
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeModal()
        document.removeEventListener("keydown", handleEsc)
      }
    }
    document.addEventListener("keydown", handleEsc)

    // モーダル外クリックで閉じる
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModal()
      }
    })

    cancelButton.addEventListener("click", closeModal)

    saveButton.addEventListener("click", async () => {
      const focusValue = parseInt(
        focusRating.getAttribute("data-rating") || "0",
      )
      const energyValue = parseInt(
        energyRating.getAttribute("data-rating") || "0",
      )

      await this.saveTaskComment(inst, {
        comment: (commentInput as HTMLTextAreaElement).value,
        energy: energyValue,
        focus: focusValue,
      })
      closeModal()
      this.renderTaskList()
    })

    document.body.appendChild(modal)
    commentInput.focus()
  }

  // 星評価ヘルパー関数
  private setRating(ratingEl: HTMLElement, value: number): void {
    ratingEl.setAttribute("data-rating", value.toString())
    this.updateRatingDisplay(ratingEl, value)
  }

  private highlightRating(ratingEl: HTMLElement, value: number): void {
    this.updateRatingDisplay(ratingEl, value)
  }

  private resetRatingHighlight(ratingEl: HTMLElement): void {
    const currentRating = parseInt(ratingEl.getAttribute("data-rating") || "0")
    this.updateRatingDisplay(ratingEl, currentRating)
  }

  private updateRatingDisplay(ratingEl: HTMLElement, value: number): void {
    const stars = ratingEl.querySelectorAll(".star")
    stars.forEach((star, index) => {
      if (index < value) {
        star.classList.add("taskchute-star-filled")
        star.classList.remove("taskchute-star-empty")
      } else {
        star.classList.add("taskchute-star-empty")
        star.classList.remove("taskchute-star-filled")
      }
    })
  }

  // 10段階を5段階に変換
  private convertToFiveScale(value: number): number {
    if (value === 0) return 0
    if (value > 5) return Math.ceil(value / 2)
    return value
  }

  private async hasCommentData(inst: TaskInstance): Promise<boolean> {
    try {
      const existingComment = await this.getExistingTaskComment(inst)
      if (!existingComment) {
        return false
      }

      return (
        (existingComment.executionComment &&
          existingComment.executionComment.trim().length > 0) ||
        existingComment.focusLevel > 0 ||
        existingComment.energyLevel > 0
      )
    } catch {
      return false
    }
  }

  private async getExistingTaskComment(
    inst: TaskInstance,
  ): Promise<TaskLogEntry | null> {
    try {
      // instanceIdが存在しない場合は、コメントなしとして扱う
      if (!inst.instanceId) {
        return null
      }

      // 月次ログファイルのパス生成
      const currentDate = this.currentDate
      const year = currentDate.getFullYear()
      const month = (currentDate.getMonth() + 1).toString().padStart(2, "0")
      const day = currentDate.getDate().toString().padStart(2, "0")
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`

      // JSONファイルを読み込み
      const logFile = this.app.vault.getAbstractFileByPath(logFilePath)
      if (!logFile || !(logFile instanceof TFile)) {
        return null
      }

      const logContent = await this.app.vault.read(logFile)
      const monthlyLog = this.parseTaskLog(logContent)

      // 該当日付のタスク実行ログから検索
      const dateString = `${year}-${month}-${day}`
      const todayTasks = monthlyLog.taskExecutions[dateString] ?? []

      // instanceIdが一致するエントリを検索
      const existingEntry = todayTasks.find(
        (entry) => entry.instanceId === inst.instanceId,
      )

      return existingEntry ?? null
    } catch {
      return null
    }
  }

  private async saveTaskComment(
    inst: TaskInstance,
    data: { comment: string; energy: number; focus: number },
  ): Promise<void> {
    try {
      // instanceIdが存在しない場合はエラー
      if (!inst.instanceId) {
        throw new Error("instanceId is required")
      }

      // 月次ログファイルのパス生成
      const currentDate = this.currentDate
      const year = currentDate.getFullYear()
      const month = (currentDate.getMonth() + 1).toString().padStart(2, "0")
      const day = currentDate.getDate().toString().padStart(2, "0")
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`
      const dateString = `${year}-${month}-${day}`

      // JSONファイルを読み込み（存在しない場合は新規作成）
      const logFile = this.app.vault.getAbstractFileByPath(logFilePath)
      let monthlyLog: TaskLogSnapshot = { taskExecutions: {}, dailySummary: {} }

      if (logFile && logFile instanceof TFile) {
        const logContent = await this.app.vault.read(logFile)
        monthlyLog = this.parseTaskLog(logContent)
      }

      if (!monthlyLog.taskExecutions[dateString]) {
        monthlyLog.taskExecutions[dateString] = []
      }

      const todayTasks = monthlyLog.taskExecutions[dateString]

      // instanceIdが一致するエントリを検索
      const existingIndex = todayTasks.findIndex(
        (entry) => entry.instanceId === inst.instanceId,
      )
      const existingTaskData =
        existingIndex >= 0 ? { ...todayTasks[existingIndex] } : null

      // コメントデータの構造を仕様に合わせる（JSON安全な最小構造）
      const pad = (n: number) => String(n).padStart(2, "0")
      const toHMS = (d?: Date) =>
        d
          ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
          : ""
      const durationSec =
        inst.startTime && inst.stopTime
          ? Math.floor(
              this.calculateCrossDayDuration(inst.startTime, inst.stopTime) /
                1000,
            )
          : 0

      const commentData: TaskLogEntry & {
        project_path: string | null
        project: string | null
        timestamp: string
        duration: number
        isCompleted: boolean
      } = {
        instanceId: inst.instanceId,
        taskPath: inst.task?.path || "",
        taskName: inst.task?.name || "",
        startTime: toHMS(inst.startTime),
        stopTime: toHMS(inst.stopTime),
        duration: durationSec,
        executionComment: (data.comment || "").trim(),
        focusLevel: data.focus || 0,
        energyLevel: data.energy || 0,
        isCompleted: inst.state === "done",
        project_path: inst.task?.projectPath || null,
        project: inst.task?.projectTitle
          ? `[[${inst.task.projectTitle}]]`
          : null,
        timestamp: new Date().toISOString(),
      }

      if (existingIndex >= 0) {
        // 既存エントリを更新
        todayTasks[existingIndex] = {
          ...todayTasks[existingIndex],
          // 変化しうるフィールドのみ更新
          executionComment: commentData.executionComment,
          focusLevel: commentData.focusLevel,
          energyLevel: commentData.energyLevel,
          startTime:
            commentData.startTime || todayTasks[existingIndex].startTime,
          stopTime: commentData.stopTime || todayTasks[existingIndex].stopTime,
          duration: durationSec || todayTasks[existingIndex].duration,
          isCompleted: commentData.isCompleted,
          project_path:
            commentData.project_path ?? todayTasks[existingIndex].project_path,
          project: commentData.project ?? todayTasks[existingIndex].project,
          lastCommentUpdate: new Date().toISOString(),
          timestamp: commentData.timestamp,
        }
      } else {
        // 新規エントリを追加
        todayTasks.push(commentData)
      }

      // JSONファイルに保存
      const serialized = JSON.stringify(monthlyLog, null, 2)
      if (logFile && logFile instanceof TFile) {
        await this.app.vault.modify(logFile, serialized)
      } else {
        await this.app.vault.create(logFilePath, serialized)
      }

      // プロジェクトノートへの同期（コメント本文が変更された場合のみ）
      const completionData = {
        executionComment: (data.comment || "").trim(),
        focusLevel: data.focus,
        energyLevel: data.energy,
      }

      if (
        completionData.executionComment &&
        (inst.task.projectPath || inst.task.projectTitle) &&
        this.hasCommentChanged(existingTaskData, completionData)
      ) {
        await this.syncCommentToProjectNote(inst, completionData)
      }

      new Notice(this.tv('comment.saved', 'Comment saved'))
    } catch (error) {
      console.error("Failed to save comment:", error)
      new Notice(this.tv('comment.saveFailed', 'Failed to save comment'))
    }
  }

  // コメント本文の変更検出
  private hasCommentChanged(
    oldData: TaskLogEntry | null | undefined,
    newData: { executionComment?: string } | null | undefined,
  ): boolean {
    const oldComment = (oldData?.executionComment ?? "") as string
    const newComment = (newData?.executionComment ?? "") as string
    return oldComment !== newComment
  }

  // プロジェクトノートにコメントを同期
  private async syncCommentToProjectNote(
    inst: TaskInstance,
    completionData: { executionComment: string },
  ): Promise<void> {
    try {
      const syncManager = new ProjectNoteSyncManager(
        this.app,
        this.plugin.pathManager,
      )
      const projectPath = await syncManager.getProjectNotePath(inst)
      if (!projectPath) return
      await syncManager.updateProjectNote(projectPath, inst, completionData)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('project.noteSyncFailed', 'Failed to update project note: {message}', {
          message,
        }),
      )
    }
  }

  private showRoutineEditModal(task: TaskData, button: HTMLElement): void {
    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    const taskTitle = deriveRoutineModalTitle(task)
    modalHeader.createEl(
      "h3",
      {
        text: this.tv('routineEdit.title', `Routine settings for "${taskTitle}"`, {
          name: taskTitle,
        }),
      },
    )

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: {
        title: t("common.close", "Close"),
      },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // ルーチンタイプ選択
    const typeGroup = form.createEl("div", { cls: "form-group" })
    typeGroup.createEl("label", {
      text: this.tv("forms.routineType", "Routine type:"),
      cls: "form-label",
    })
    const typeSelect = typeGroup.createEl("select", {
      cls: "form-input",
    }) as HTMLSelectElement

    // オプション追加
    const options = [
      { value: "daily", text: this.tv("forms.routineDaily", "Daily") },
      { value: "weekly", text: this.tv("forms.routineWeekly", "Weekly (by weekday)") },
      { value: "monthly", text: this.tv("forms.routineMonthly", "Monthly (weekday)") },
    ]

    options.forEach((opt) => {
      const option = typeSelect.createEl("option", {
        value: opt.value,
        text: opt.text,
      })
      if (task.routine_type === opt.value) {
        option.selected = true
      }
    })

    // 現在のルーチンタイプまたはデフォルト（未指定は日ごと+間隔1）
    typeSelect.value =
      task.routine_type === "weekly" || task.routine_type === "monthly"
        ? task.routine_type
        : "daily"

    // 開始時刻入力（互換性レイヤー経由）
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", {
      text: this.tv("forms.scheduledTimeLabel", "Scheduled start time:"),
      cls: "form-label",
    })
    const timeInput = timeGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: task.scheduledTime || "09:00",
    }) as HTMLInputElement

    // 間隔入力（共通）
    const intervalGroup = form.createEl("div", { cls: "form-group" })
    intervalGroup.createEl("label", {
      text: this.tv("forms.interval", "Interval:"),
      cls: "form-label",
    })
    const intervalInput = intervalGroup.createEl("input", {
      type: "number",
      cls: "form-input",
      attr: { min: "1", step: "1" },
      value: String(task.routine_interval ?? 1),
    }) as HTMLInputElement

    // 有効トグル
    const enabledGroup = form.createEl("div", { cls: "form-group" })
    enabledGroup.createEl("label", {
      text: this.tv("forms.enabled", "Enabled:"),
      cls: "form-label",
    })
    const enabledToggle = enabledGroup.createEl("input", {
      type: "checkbox",
    }) as HTMLInputElement
    enabledToggle.checked = task.routine_enabled !== false // default true

    // 週次設定グループ（初期非表示）
    const weeklyGroup = form.createEl("div", {
      cls: "form-group routine-weekly-group",
    })
    weeklyGroup.classList.add("is-hidden")
    weeklyGroup.createEl("label", {
      text: this.tv("forms.selectWeekdays", "Select weekdays:"),
      cls: "form-label",
    })
    const weekdayContainer = weeklyGroup.createEl("div", {
      cls: "weekday-checkboxes",
    })

    const weekdayNames = this.getWeekdayNames()
    const weekdays = weekdayNames.map((label, value) => ({ value, label }))

    const weekdayCheckboxes: HTMLInputElement[] = []
    weekdays.forEach((day) => {
      const label = weekdayContainer.createEl("label", {
        cls: "weekday-checkbox-label",
      })
      const checkbox = label.createEl("input", {
        type: "checkbox",
        value: day.value.toString(),
      }) as HTMLInputElement
      weekdayCheckboxes.push(checkbox)

      label.createEl("span", { text: day.label })
      // 単一選択にする
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          weekdayCheckboxes.forEach((cb) => {
            if (cb !== checkbox) cb.checked = false
          })
        }
      })
    })

    const preselectedWeekdays = deriveWeeklySelection(task)
    preselectedWeekdays.forEach((day) => {
      const checkbox = weekdayCheckboxes[day]
      if (checkbox) {
        checkbox.checked = true
      }
    })

    // 月次設定グループ（初期非表示）
    const monthlyGroup = form.createEl("div", {
      cls: "form-group routine-monthly-group",
    })
    monthlyGroup.classList.add("is-hidden")
    monthlyGroup.createEl("label", {
      text: this.tv("forms.monthlySettings", "Monthly settings:"),
      cls: "form-label",
    })

    const monthlyContainer = monthlyGroup.createEl("div", {
      cls: "monthly-settings",
    })

    monthlyContainer.createEl("span", {
      text: this.tv("forms.nth", "Nth"),
    })
    const weekSelect = monthlyContainer.createEl("select", {
      cls: "form-input monthly-settings__week",
    }) as HTMLSelectElement

    for (let i = 1; i <= 5; i++) {
      weekSelect.createEl("option", {
        value: (i - 1).toString(),
        text: i.toString(),
      })
    }
    weekSelect.createEl("option", {
      value: "last",
      text: this.tv("forms.lastWeek", "Last"),
    })

    monthlyContainer.createEl("span", {
      text: this.tv("forms.weekOf", " week"),
    })
    const monthlyWeekdaySelect = monthlyContainer.createEl("select", {
      cls: "form-input monthly-settings__weekday",
    }) as HTMLSelectElement

    weekdays.forEach((day) => {
      monthlyWeekdaySelect.createEl("option", {
        value: day.value.toString(),
        text: `${day.label}${this.tv("forms.weekdaySuffix", " weekday")}`,
      })
    })

    const { week: initialMonthlyWeek, weekday: initialMonthlyWeekday } = deriveMonthlySelection(task)
    if (initialMonthlyWeek === 'last') {
      weekSelect.value = 'last'
    } else if (typeof initialMonthlyWeek === 'number') {
      const zeroBased = Math.max(0, Math.min(4, initialMonthlyWeek - 1))
      weekSelect.value = String(zeroBased)
    }
    if (typeof initialMonthlyWeekday === 'number') {
      monthlyWeekdaySelect.value = String(initialMonthlyWeekday)
    }

    // タイプ変更時の表示切り替え
    typeSelect.addEventListener("change", () => {
      const selectedType = typeSelect.value

      // 全て非表示にする
      weeklyGroup.classList.toggle("is-hidden", selectedType !== "weekly")
      monthlyGroup.classList.toggle("is-hidden", selectedType !== "monthly")
    })

    // 初期表示設定
    weeklyGroup.classList.toggle("is-hidden", typeSelect.value !== "weekly")
    monthlyGroup.classList.toggle("is-hidden", typeSelect.value !== "monthly")

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: t("common.cancel", "Cancel"),
    })
    buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: this.tv("buttons.save", "Save"),
    })

    // 既存のルーチンタスクの場合のみ「ルーチンを外す」ボタンを表示
    let removeButton: HTMLButtonElement | null = null
    if (task.isRoutine) {
      removeButton = buttonGroup.createEl("button", {
        type: "button",
        cls: "form-button cancel",
        text: this.tv('buttons.removeRoutine', 'Remove from routine'),
      }) as HTMLButtonElement
    }

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    if (removeButton) {
      removeButton.addEventListener("click", async (e) => {
        e.preventDefault()
        e.stopPropagation()
        await this.toggleRoutine(task, button)
        if (modal.parentNode) document.body.removeChild(modal)
      })
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const scheduledTime = timeInput.value
      const routineType = typeSelect.value
      const interval = Math.max(
        1,
        parseInt(intervalInput.value || "1", 10) || 1,
      )
      const enabled = !!enabledToggle.checked

      if (!scheduledTime) {
        new Notice(
          this.tv("forms.scheduledTimePlaceholder", "Enter a scheduled start time"),
        )
        return
      }

      // 週次の場合、曜日が選択されているか確認
      if (routineType === "weekly") {
        const selectedWeekdays = weekdayCheckboxes
          .filter((cb) => cb.checked)
          .map((cb) => parseInt(cb.value))

        if (selectedWeekdays.length === 0) {
          new Notice(
            this.tv("forms.selectWeekdaysPrompt", "Please select at least one weekday"),
          )
          return
        }
      }

      // ルーチンタスクとして設定
      await this.setRoutineTaskWithDetails(
        task,
        button,
        scheduledTime,
        routineType,
        {
          weekdays:
            routineType === "weekly"
              ? weekdayCheckboxes
                  .filter((cb) => cb.checked)
                  .map((cb) => parseInt(cb.value))
              : undefined,
          monthly_week:
            routineType === "monthly"
              ? weekSelect.value === "last"
                ? "last"
                : parseInt(weekSelect.value)
              : undefined,
          monthly_weekday:
            routineType === "monthly"
              ? parseInt(monthlyWeekdaySelect.value)
              : undefined,
          interval,
          enabled,
        },
      )

      document.body.removeChild(modal)
    })

    // モーダルを表示
    document.body.appendChild(modal)
    timeInput.focus()
  }

  private async toggleRoutine(
    task: TaskData,
    button: HTMLElement,
  ): Promise<void> {
    try {
      if (task.isRoutine) {
        // 解除時のみ即ファイルにアクセス
        const file =
          (task.path && this.app.vault.getAbstractFileByPath(task.path)) || null
        if (!file || !(file instanceof TFile)) {
          // Fallback: タスクフォルダ直下
          const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
          const fallbackBase = task.name || task.displayTitle || 'Untitled Task'
          const fallbackPath = `${taskFolderPath}/${fallbackBase}.md`
          const fb = this.app.vault.getAbstractFileByPath(fallbackPath)
          if (!fb || !(fb instanceof TFile)) {
            new Notice(
              this.tv('project.fileMissing', 'Task file "{title}.md" not found', {
                title: fallbackBase,
              }),
            )
            return
          }
          await this.app.fileManager.processFrontMatter(fb, (frontmatter) => {
            const y = this.currentDate.getFullYear()
            const m = (this.currentDate.getMonth() + 1)
              .toString()
              .padStart(2, "0")
            const d = this.currentDate.getDate().toString().padStart(2, "0")
            frontmatter.routine_end = `${y}-${m}-${d}`
            frontmatter.isRoutine = false
            setScheduledTime(frontmatter, undefined)
            return frontmatter
          })
        } else {
          // ルーチンタスクを解除
          await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const y = this.currentDate.getFullYear()
            const m = (this.currentDate.getMonth() + 1)
              .toString()
              .padStart(2, "0")
            const d = this.currentDate.getDate().toString().padStart(2, "0")
            frontmatter.routine_end = `${y}-${m}-${d}`
            frontmatter.isRoutine = false
            setScheduledTime(frontmatter, undefined)
            return frontmatter
          })
        }

        // 状態リセット
        task.isRoutine = false
        task.scheduledTime = null
        button.classList.remove("active")
        button.setAttribute(
          "title",
          this.tv('tooltips.routineSet', 'Set as routine'),
        )

        // タスク情報を再取得し、実行中タスクの表示も復元
        await this.reloadTasksAndRestore()
        new Notice(this.tv('notices.routineDetached', 'Detached from routine'))
      } else {
        // ルーチンタスクに設定（時刻入力ポップアップを表示）
        this.showRoutineEditModal(task, button)
      }
    } catch (error: unknown) {
      console.error("[TaskChute] toggleRoutine failed:", error)
      const msg = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.routineSetFailed', 'Failed to set routine task: {message}', {
          message: msg,
        }),
      )
    }
  }

  private showTaskSettingsTooltip(
    inst: TaskInstance,
    button: HTMLElement,
  ): void {
    // 既存のツールチップを削除
    const existingTooltip = document.querySelector(".task-settings-tooltip")
    if (existingTooltip) {
      existingTooltip.remove()
    }

    // ツールチップコンテナを作成
    const tooltip = document.createElement("div")
    tooltip.className = "task-settings-tooltip"

    // ヘッダー部分（バツボタン用）
    const tooltipHeader = tooltip.createEl("div", {
      cls: "tooltip-header",
    })

    // バツボタンを追加
    const closeButton = tooltipHeader.createEl("button", {
      cls: "tooltip-close-button",
      text: "×",
      attr: { title: t("common.close", "Close") },
    })
    closeButton.addEventListener("click", (e) => {
      e.stopPropagation()
      tooltip.remove()
    })

    // 「未実行に戻す」項目を追加
    const resetItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: this.tv("buttons.resetToNotStarted", "↩️ Reset to not started"),
    })
    if (inst.state === "idle") {
      resetItem.classList.add("disabled")
      resetItem.setAttribute(
        "title",
        this.tv("forms.feedbackPrompt", "This task is not started"),
      )
    } else {
      resetItem.setAttribute(
        "title",
        this.tv("forms.feedbackDescription", "Reset the task to its pre-start state"),
      )
    }
    resetItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      if (inst.state !== "idle") {
        await this.resetTaskToIdle(inst)
      }
    })

    // 「開始時刻を設定」項目を追加
    const setTimeItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: this.tv("buttons.setStartTime", "🕐 Set start time"),
    })
    setTimeItem.setAttribute(
      "title",
      this.tv("forms.startTimeInfo", "Set the scheduled start time. Leave empty to clear it."),
    )
    setTimeItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      await this.showScheduledTimeEditModal(inst)
    })

    // 「タスクを移動」項目を追加
    const moveItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: this.tv("buttons.moveTask", "📅 Move task"),
    })
    moveItem.setAttribute(
      "title",
      this.tv("forms.moveDescription", "Move the task to another date"),
    )
    moveItem.addEventListener("click", (e) => {
      e.stopPropagation()
      tooltip.remove()
      this.showTaskMoveDatePicker(inst, button)
    })

    // 「タスクを複製」項目を追加
    const duplicateItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: this.tv("buttons.duplicateTask", "📄 Duplicate task"),
    })
    duplicateItem.setAttribute(
      "title",
      this.tv("forms.duplicateDescription", "Insert a duplicate task below"),
    )
    duplicateItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      await this.duplicateInstance(inst)
    })

    // 削除項目を追加
    const deleteItem = tooltip.createEl("div", {
      cls: "tooltip-item delete-item",
      text: this.tv("buttons.deleteTask", "🗑️ Delete task"),
    })
    deleteItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      // 履歴の存在で判定
      const hasHistory = await this.hasExecutionHistory(inst.task.path)
      // 統一された削除処理を使用
      if (inst.task.isRoutine || hasHistory) {
        await this.deleteRoutineTask(inst)
      } else {
        await this.deleteNonRoutineTask(inst)
      }
    })

    // ボタンの位置を取得してツールチップを配置
    const buttonRect = button.getBoundingClientRect()
    const windowHeight = window.innerHeight
    const windowWidth = window.innerWidth
    const tooltipHeight = 250 // 推定されるツールチップの高さ
    const tooltipWidth = 200 // 推定されるツールチップの幅

    let top = buttonRect.bottom + 5
    if (top + tooltipHeight > windowHeight) {
      top = Math.max(buttonRect.top - tooltipHeight - 5, 0)
    }

    let left = buttonRect.left
    if (left + tooltipWidth > windowWidth) {
      left = Math.max(windowWidth - tooltipWidth - 10, 0)
    }

    tooltip.classList.add("taskchute-tooltip")
    tooltip.style.setProperty("--taskchute-tooltip-left", `${left}px`)
    tooltip.style.setProperty("--taskchute-tooltip-top", `${top}px`)

    // ドキュメントに追加
    document.body.appendChild(tooltip)

    // クリック外で閉じる
    const closeTooltip = (e: MouseEvent) => {
      if (!tooltip.contains(e.target as Node) && e.target !== button) {
        tooltip.remove()
        document.removeEventListener("click", closeTooltip)
      }
    }

    setTimeout(() => {
      document.addEventListener("click", closeTooltip)
    }, 100)
  }

  // ===========================================
  // Task State Management Methods
  // ===========================================

  async startInstance(inst: TaskInstance): Promise<void> {
    try {
      // 未来日の保護: 表示日が今日より未来なら開始不可
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const viewDate = new Date(this.currentDate)
      viewDate.setHours(0, 0, 0, 0)
      if (viewDate.getTime() > today.getTime()) {
        new Notice(
          this.tv(
            "notices.futureTaskPreventedWithPeriod",
            "Cannot start a future task.",
          ),
          2000,
        )
        return
      }

      // Allow concurrent running tasks: do NOT auto-stop previously running ones

      // Move the instance to the current time slot before starting
      // Spec: startInstance should relocate the instance into the current slot
      // so that running tasks always appear under "now" (e.g. 0:00-8:00 at 00:30)
      try {
        const currentSlot = getCurrentTimeSlot(new Date())
        if (inst.slotKey !== currentSlot) {
          if (!inst.originalSlotKey) inst.originalSlotKey = inst.slotKey
          inst.slotKey = currentSlot
        }
      } catch {
        /* fail-safe: keep original slot on error */
      }

      // Start the new instance
      inst.state = "running"
      inst.startTime = new Date()
      this.currentInstance = inst

      // 非ルーチンで表示日≠今日の時は target_date を今日に移動
      try {
        if (!inst.task.isRoutine && viewDate.getTime() !== today.getTime()) {
          const file = this.app.vault.getAbstractFileByPath(inst.task.path)
          if (file instanceof TFile) {
            const y = today.getFullYear()
            const m = String(today.getMonth() + 1).padStart(2, "0")
            const d = String(today.getDate()).padStart(2, "0")
            await this.app.fileManager.processFrontMatter(file, (fm) => {
              fm.target_date = `${y}-${m}-${d}`
              return fm
            })
          }
        }
      } catch {}

      // Save running task state for persistence
      await this.saveRunningTasksState()

      // Update UI
      this.renderTaskList()

      // Start/ensure global timer is running
      if (!this.globalTimerInterval) this.startGlobalTimer()

      new Notice(
        this.tv('notices.taskStarted', 'Started {name}', {
          name: inst.task.name,
        }),
      )
    } catch (error) {
      console.error("Failed to start instance:", error)
      new Notice(this.tv("notices.taskStartFailed", "Failed to start task"))
    }
  }

  async stopInstance(inst: TaskInstance): Promise<void> {
    try {
      if (inst.state !== "running") {
        return
      }

      inst.state = "done"
      inst.stopTime = new Date()

      if (inst.startTime) {
        const duration = this.calculateCrossDayDuration(
          inst.startTime,
          inst.stopTime,
        )
        inst.actualMinutes = Math.floor(duration / (1000 * 60))
      }

      // Clear current instance if this is it
      if (this.currentInstance === inst) {
        this.currentInstance = null
      }

      // Save to log via service
      const duration = Math.floor(
        this.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000,
      )
      await this.executionLogService.saveTaskLog(inst, duration)

      // Save running task state (remove this task from running tasks)
      await this.saveRunningTasksState()

      // Restart/stop timer service depending on current running tasks
      this.timerService?.restart()

      // Update yearly heatmap stats (start date basis)
      try {
        const start = inst.startTime || new Date()
        const yyyy = start.getFullYear()
        const mm = String(start.getMonth() + 1).padStart(2, "0")
        const dd = String(start.getDate()).padStart(2, "0")
        const dateStr = `${yyyy}-${mm}-${dd}`
        const heatmap = new HeatmapService(this.plugin)
        await heatmap.updateDailyStats(dateStr)
      } catch {}

      // CRITICAL: Recalculate task orders to maintain execution time order
      // This ensures completed tasks are sorted by startTime immediately
      this.sortTaskInstancesByTimeOrder()
      await this.saveTaskOrders()

      // Update UI
      this.renderTaskList()

      new Notice(
        this.tv('notices.taskCompleted', 'Completed {name} ({minutes} min)', {
          name: inst.task.name,
          minutes: inst.actualMinutes || 0,
        }),
      )
    } catch (error) {
      console.error("Failed to stop instance:", error)
      new Notice(this.tv("notices.taskStopFailed", "Failed to stop task"))
    }
  }

  private calculateCrossDayDuration(startTime: Date, stopTime: Date): number {
    if (!startTime || !stopTime) return 0

    let duration = stopTime.getTime() - startTime.getTime()

    // If negative, it's a cross-day task
    if (duration < 0) {
      duration += 24 * 60 * 60 * 1000
    }

    return duration
  }

  // ===========================================
  // Running Task Persistence Methods
  // ===========================================

  async saveRunningTasksState(): Promise<void> {
    try {
      const runningInstances = this.taskInstances.filter(
        (inst) => inst.state === "running",
      )
      await this.runningTasksService.save(runningInstances)
    } catch (e) {
      console.error(
        this.tv(
          "notices.runningTaskSaveFailed",
          "[TaskChute] Failed to save running task:",
        ),
        e,
      )
    }
  }

  async restoreRunningTaskState(): Promise<void> {
    try {
      // 現在の日付文字列を取得
      const currentDateString = this.getCurrentDateString()
      // サービスから当日分のレコードを取得
      const runningTasksData = await this.runningTasksService.loadForDate(
        currentDateString,
      )
      if (!Array.isArray(runningTasksData) || runningTasksData.length === 0)
        return

      // 削除済みタスクリストを取得
      const deletedInstances = this.getDeletedInstances(currentDateString)
      const deletedTasks = deletedInstances
        .filter((inst) => inst.deletionType === "permanent")
        .map((inst) => inst.path)

      let restored = false
      for (const runningData of runningTasksData) {
        if (runningData.date !== currentDateString) {
          continue
        }

        // 削除済みタスクはスキップ
        if (
          runningData.taskPath &&
          deletedTasks.includes(runningData.taskPath)
        ) {
          continue
        }

        // 既存のインスタンスを検索
        // 1) instanceId 完全一致を最優先
        let runningInstance = this.taskInstances.find(
          (inst) => inst.instanceId === runningData.instanceId,
        )
        // 2) 見つからなければ path 一致かつ idle のものを検索（slot は後で移動）
        if (!runningInstance) {
          runningInstance = this.taskInstances.find(
            (inst) =>
              inst.task.path === runningData.taskPath && inst.state === "idle",
          )
        }

        if (runningInstance) {
          // slotKey を保存データに合わせて移動（なければ現在スロット）
          try {
            const desiredSlot =
              runningData.slotKey || getCurrentTimeSlot(new Date())
            if (runningInstance.slotKey !== desiredSlot) {
              if (!runningInstance.originalSlotKey) {
                runningInstance.originalSlotKey = runningInstance.slotKey
              }
              runningInstance.slotKey = desiredSlot
            }
          } catch {}

          // 状態と時刻を復元
          runningInstance.state = "running"
          runningInstance.startTime = new Date(runningData.startTime)
          runningInstance.stopTime = null
          if (
            runningData.instanceId &&
            runningInstance.instanceId !== runningData.instanceId
          ) {
            // 継続性のため instanceId を採用
            runningInstance.instanceId = runningData.instanceId
          }
          if (!runningInstance.originalSlotKey && runningData.originalSlotKey) {
            runningInstance.originalSlotKey = runningData.originalSlotKey
          }
          this.currentInstance = runningInstance
          restored = true
        } else {
          // 見つからない場合は再作成（spec: 復元の堅牢性）
          const taskData = this.tasks.find(
            (t) => t.path === runningData.taskPath,
          )
          if (taskData) {
            const recreated: TaskInstance = {
              task: taskData,
              instanceId:
                runningData.instanceId ||
                this.generateInstanceId(taskData, currentDateString),
              state: "running",
              slotKey: runningData.slotKey || getCurrentTimeSlot(new Date()),
              originalSlotKey: runningData.originalSlotKey,
              startTime: new Date(runningData.startTime),
              stopTime: null,
            }
            this.taskInstances.push(recreated)
            this.currentInstance = recreated
            restored = true
          }
        }
      }

      if (restored) {
        this.startGlobalTimer() // タイマー管理を再開
        this.renderTaskList() // UIを更新
      }
    } catch (e) {
      console.error(
        this.tv(
          "notices.runningTaskRestoreFailed",
          "[TaskChute] Failed to restore running task:",
        ),
        e,
      )
    }
  }

  // saveTaskLog moved to ExecutionLogService

  /**
   * Remove an execution log entry for the given instance on the current view date
   * and recalculate the daily summary. This is used when a completed task is
   * reverted back to idle ("未実行に戻す").
   */
  private async removeTaskLogForInstanceOnCurrentDate(
    instanceId: string,
  ): Promise<void> {
    try {
      if (!instanceId) return
      const dateStr = this.getCurrentDateString()
      await this.executionLogService.removeTaskLogForInstanceOnDate(
        instanceId,
        dateStr,
      )
    } catch (e) {
      console.error(
        "[TaskChute] removeTaskLogForInstanceOnCurrentDate failed:",
        e,
      )
    }
  }

  // ===========================================
  // Timer Management Methods
  // ===========================================

  private startGlobalTimer(): void {
    // Backward-compat API: now uses TimerService
    this.ensureTimerService()
    this.timerService?.start()
  }

  private updateAllTimers(): void {
    // Kept for compatibility: delegate to TimerService one-shot tick
    this.ensureTimerService()
    const running = this.taskInstances.filter(
      (inst) => inst.state === "running",
    )
    if (running.length === 0) {
      this.stopGlobalTimer()
      return
    }
    running.forEach((inst) => this.onTimerTick(inst))
  }

  // ===========================================
  // Time Edit Modal (開始/終了時刻の編集)
  // ===========================================

  private async showScheduledTimeEditModal(inst: TaskInstance): Promise<void> {
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    modalContent.createEl("h3", {
      text: this.tv(
        'forms.scheduledTimeModalTitle',
        'Set scheduled start time',
      ),
      cls: "modal-title",
    })

    const form = modalContent.createEl("form", { cls: "task-form" })

    // Scheduled time input
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", {
      text: this.tv("forms.scheduledTimeLabel", "Scheduled start time:"),
      cls: "form-label",
    })

    // Get current scheduled time using fieldMigration utility
    const currentTime = getScheduledTime(inst.task.frontmatter || {})

    const timeInput = timeGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: currentTime || "",
    }) as HTMLInputElement

    // Description
    modalContent.createEl("p", {
      cls: "modal-description",
      text: this.tv(
        "forms.startTimeInfo",
        "Set the scheduled start time. Leave empty to clear it.",
      ),
    })

    // Buttons
    const buttonRow = modalContent.createEl("div", { cls: "task-modal-buttons" })
    const saveButton = buttonRow.createEl("button", {
      text: this.tv("buttons.save", "Save"),
      cls: "primary",
    })
    const cancelButton = buttonRow.createEl("button", {
      text: t("common.cancel", "Cancel"),
    })

    saveButton.addEventListener("click", async (e) => {
      e.preventDefault()
      const newTime = timeInput.value.trim()

      try {
        if (!inst.task.path) {
          new Notice(this.tv("notices.taskFileMissing", "Task file not found"))
          return
        }

        const file = this.app.vault.getAbstractFileByPath(inst.task.path)
        if (!(file instanceof TFile)) {
          new Notice(this.tv("notices.taskFileMissing", "Task file not found"))
          return
        }

        // Update frontmatter using fieldMigration utility
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          setScheduledTime(frontmatter, newTime || undefined, { preferNew: true })
        })

        // Reload tasks to reflect changes
        await this.reloadTasksAndRestore({ runBoundaryCheck: true })

        new Notice(
          newTime
            ? this.tv('forms.startTimeUpdated', 'Scheduled start time set to {time}', {
                time: newTime,
              })
            : this.tv('forms.startTimeDeleted', 'Removed scheduled start time'),
        )
        modal.remove()
      } catch (error) {
        console.error("Failed to update scheduled time:", error)
        new Notice(
          this.tv(
            "forms.startTimeUpdateFailed",
            "Failed to update scheduled start time",
          ),
        )
      }
    })

    cancelButton.addEventListener("click", (e) => {
      e.preventDefault()
      modal.remove()
    })

    // Close on escape
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        modal.remove()
        document.removeEventListener("keydown", handleEscape)
      }
    }
    document.addEventListener("keydown", handleEscape)

    document.body.appendChild(modal)
    timeInput.focus()
  }

  private showTimeEditModal(inst: TaskInstance): void {
    // Safety: only for running/done with a start time
    if (
      !(inst.startTime && (inst.state === "running" || inst.state === "done"))
    )
      return

    const displayTitle = this.getInstanceDisplayTitle(inst)
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // Header
    const header = modalContent.createEl("div", { cls: "modal-header" })
    header.createEl(
      "h3",
      {
        text: this.tv(
          'forms.timeEditTitle',
          `Edit times for "${displayTitle}"`,
          { title: displayTitle },
        ),
      },
    )
    const closeBtn = header.createEl("button", {
      cls: "modal-close-button",
      text: "×",
    })
    closeBtn.addEventListener("click", () => modal.remove())

    const form = modalContent.createEl("form", { cls: "task-form" })

    // Start time
    const startGroup = form.createEl("div", { cls: "form-group" })
    startGroup.createEl("label", {
      text: this.tv("forms.scheduledTimeLabel", "Scheduled start time:"),
      cls: "form-label",
    })
    const pad = (n: number) => String(n).padStart(2, "0")
    const toHM = (d?: Date) =>
      d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : ""
    const startInput = startGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: toHM(inst.startTime),
    }) as HTMLInputElement
    const startClear = startGroup.createEl("button", {
      type: "button",
      cls: "form-button secondary",
      text: this.tv("buttons.clear", "Clear"),
      attr: { style: "margin-left: 8px; padding: 4px 12px; font-size: 12px;" },
    })
    startClear.addEventListener("click", () => {
      startInput.value = ""
    })

    // Stop time (only for done)
    let stopInput: HTMLInputElement | null = null
    if (inst.state === "done" && inst.stopTime) {
      const stopGroup = form.createEl("div", { cls: "form-group" })
      stopGroup.createEl("label", {
        text: this.tv("forms.endTimeLabel", "End time:"),
        cls: "form-label",
      })
      stopInput = stopGroup.createEl("input", {
        type: "time",
        cls: "form-input",
        value: toHM(inst.stopTime),
      }) as HTMLInputElement
      const stopClear = stopGroup.createEl("button", {
        type: "button",
        cls: "form-button secondary",
        text: this.tv("buttons.clear", "Clear"),
        attr: {
          style: "margin-left: 8px; padding: 4px 12px; font-size: 12px;",
        },
      })
      stopClear.addEventListener("click", () => {
        if (stopInput) stopInput.value = ""
      })
    }

    // Description
    const desc = form.createEl("div", { cls: "form-group" }).createEl("p", {
      cls: "form-description",
      attr: {
        style: "margin-top: 12px; font-size: 12px; color: var(--text-muted);",
      },
    })
    if (inst.state === "running") {
      desc.textContent = this.tv(
        "forms.startTimeRemovedHint",
        "Removing the scheduled start time resets the task to not started.",
      )
    } else {
      desc.textContent = this.tv(
        "forms.endTimeResetHint",
        "Delete end time only: back to running\nDelete both: back to not started",
      )
    }

    // Buttons
    const buttons = form.createEl("div", { cls: "form-button-group" })
    const cancelBtn = buttons.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: t("common.cancel", "Cancel"),
    })
    buttons.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: this.tv("buttons.save", "Save"),
    })
    cancelBtn.addEventListener("click", () => modal.remove())

    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const newStart = (startInput.value || "").trim()
      const newStop = stopInput ? (stopInput.value || "").trim() : ""

      if (inst.state === "running") {
        if (!newStart) {
          await this.resetTaskToIdle(inst)
          modal.remove()
          return
        }
        await this.updateRunningInstanceStartTime(inst, newStart)
      } else if (inst.state === "done") {
        if (!newStart && !newStop) {
          await this.resetTaskToIdle(inst)
          modal.remove()
          return
        } else if (newStart && !newStop) {
          await this.transitionToRunningWithStart(inst, newStart)
          modal.remove()
          return
        } else if (newStart && newStop) {
          if (newStart >= newStop) {
            new Notice(
              this.tv(
                "forms.startTimeBeforeEnd",
                "Scheduled start time must be before end time",
              ),
            )
            return
          }
          await this.updateInstanceTimes(inst, newStart, newStop)
        } else {
          new Notice(
            this.tv("forms.startTimeRequired", "Scheduled start time is required"),
          )
          return
        }
      }

      modal.remove()
    })

    document.body.appendChild(modal)
    ;(startInput as HTMLInputElement).focus()
  }

  private async updateInstanceTimes(
    inst: TaskInstance,
    startStr: string,
    stopStr: string,
  ): Promise<void> {
    const displayTitle = this.getInstanceDisplayTitle(inst)
    const base = inst.startTime || new Date(this.currentDate)
    const [sh, sm] = startStr.split(":").map((n) => parseInt(n, 10))
    const [eh, em] = stopStr.split(":").map((n) => parseInt(n, 10))

    inst.startTime = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      sh,
      sm,
      0,
      0,
    )
    inst.stopTime = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      eh,
      em,
      0,
      0,
    )

    // Update slotKey based on new start time
    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.persistSlotAssignment(inst)
    }

    // Persist to monthly log via service
    const durationSec = Math.floor(
      this.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000,
    )
    await this.executionLogService.saveTaskLog(inst, durationSec)
    // Re-render
    this.renderTaskList()
    new Notice(
      this.tv('notices.taskTimesUpdated', 'Updated times for "{title}"', {
        title: displayTitle,
      }),
    )
  }

  private async updateRunningInstanceStartTime(
    inst: TaskInstance,
    startStr: string,
  ): Promise<void> {
    const displayTitle = this.getInstanceDisplayTitle(inst)
    const base = inst.startTime || new Date(this.currentDate)
    const [sh, sm] = startStr.split(":").map((n) => parseInt(n, 10))
    inst.startTime = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      sh,
      sm,
      0,
      0,
    )

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.persistSlotAssignment(inst)
    }

    await this.saveRunningTasksState()
    this.renderTaskList()
    new Notice(
      this.tv('notices.runningStartUpdated', 'Updated start time for "{title}"', {
        title: displayTitle,
      }),
    )
  }

  private async transitionToRunningWithStart(
    inst: TaskInstance,
    startStr: string,
  ): Promise<void> {
    const displayTitle = this.getInstanceDisplayTitle(inst)
    // Re-open as running with a specified start time on the same date
    if (inst.state !== "done") return
    const base = inst.startTime || new Date(this.currentDate)
    const [sh, sm] = startStr.split(":").map((n) => parseInt(n, 10))

    // Remove existing completed log for this instance on current date
    if (inst.instanceId) {
      await this.removeTaskLogForInstanceOnCurrentDate(inst.instanceId)
    }

    inst.state = "running"
    inst.startTime = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      sh,
      sm,
      0,
      0,
    )
    inst.stopTime = undefined

    const newSlot = getSlotFromTime(startStr)
    if (inst.slotKey !== newSlot) {
      inst.slotKey = newSlot
      this.persistSlotAssignment(inst)
    }

    await this.saveRunningTasksState()
    this.renderTaskList()
    new Notice(
      this.tv('notices.restoredToRunning', 'Moved "{title}" back to running', {
        title: displayTitle,
      }),
    )
  }

  private updateTimerDisplay(timerEl: HTMLElement, inst: TaskInstance): void {
    if (!inst.startTime) return

    const now = new Date()
    const elapsed = now.getTime() - inst.startTime.getTime()
    const hours = Math.floor(elapsed / (1000 * 60 * 60))
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000)

    // HH:MM:SS形式で表示（main.jsと同じ形式）
    timerEl.textContent = `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  }

  private stopGlobalTimer(): void {
    this.timerService?.stop()
  }

  // ===========================================
  // Event Handler Methods
  // ===========================================

  private setupEventListeners(): void {
    // Keyboard shortcut listener
    this.registerDomEvent(document, "keydown", (e) => {
      this.handleKeyboardShortcut(e as KeyboardEvent)
    })

    // Click listener for clearing selection
    this.registerDomEvent(this.containerEl, "click", (e) => {
      if (!e.target.closest(".task-item")) {
        this.clearTaskSelection()
      }
    })

    // File rename event listener
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        await this.handleFileRename(file, oldPath)
      }),
    )
  }

  // ===========================================
  // TimerService integration
  // ===========================================

  private ensureTimerService(): void {
    if (this.timerService) return
    this.timerService = new TimerService({
      getRunningInstances: () =>
        this.taskInstances.filter((inst) => inst.state === "running"),
      onTick: (inst) => this.onTimerTick(inst),
      intervalMs: 1000,
    })
  }

  private onTimerTick(inst: TaskInstance): void {
    const selector = `[data-instance-id="${inst.instanceId}"] .task-timer-display`
    const timerEl = this.taskList.querySelector(selector) as HTMLElement
    if (timerEl) {
      this.updateTimerDisplay(timerEl, inst)
    }
  }

  private setupPlayStopButton(button: HTMLElement, inst: TaskInstance): void {
    button.addEventListener("click", async (e) => {
      e.stopPropagation()

      if (inst.state === "running") {
        await this.stopInstance(inst)
      } else if (inst.state === "idle") {
        await this.startInstance(inst)
      }
    })
  }

  private setupTaskItemEventListeners(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    // Context menu
    taskItem.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      this.showTaskContextMenu(e, inst)
    })

    // Drag and drop
    this.setupTaskItemDragDrop(taskItem, inst)

    // Row click selects the task for keyboard actions (avoid buttons/inputs)
    taskItem.addEventListener("click", (e) => {
      const target = e.target as HTMLElement
      if (
        target.closest(
          'button, a, input, textarea, .drag-handle, [contenteditable="true"]',
        )
      )
        return
      this.selectTaskForKeyboard(inst, taskItem)
    })
  }

  private setupTaskItemDragDrop(
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    taskItem.addEventListener("dragover", (e) => {
      e.preventDefault()
      this.handleDragOver(e, taskItem, inst)
    })

    taskItem.addEventListener("dragleave", () => {
      this.clearDragoverClasses(taskItem)
    })

    taskItem.addEventListener("drop", (e) => {
      e.preventDefault()
      this.handleDrop(e, taskItem, inst)
    })
  }

  private setupDragEvents(
    dragHandle: HTMLElement,
    taskItem: HTMLElement,
    slot: string,
    idx: number,
  ): void {
    dragHandle.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", `${slot ?? "none"}::${idx}`)
      taskItem.classList.add("dragging")
    })

    dragHandle.addEventListener("dragend", () => {
      taskItem.classList.remove("dragging")
    })
  }

  private setupTimeSlotDragHandlers(header: HTMLElement, slot: string): void {
    header.addEventListener("dragover", (e) => {
      e.preventDefault()
      header.classList.add("dragover")
    })

    header.addEventListener("dragleave", () => {
      header.classList.remove("dragover")
    })

    header.addEventListener("drop", (e) => {
      e.preventDefault()
      header.classList.remove("dragover")
      this.handleSlotDrop(e, slot)
    })
  }

  // ===========================================
  // Command Methods (for external commands)
  // ===========================================

  async duplicateSelectedTask(): Promise<void> {
    if (this.selectedTaskInstance) {
      await this.duplicateInstance(this.selectedTaskInstance)
      this.clearTaskSelection()
    } else {
      new Notice(this.tv("notices.taskNotSelected", "No task selected"))
    }
  }

  deleteSelectedTask(): void {
    if (this.selectedTaskInstance) {
      // 削除確認モーダルを表示
      this.showDeleteConfirmDialog(this.selectedTaskInstance).then(
        (confirmed) => {
          if (confirmed) {
            this.deleteTask(this.selectedTaskInstance)
          }
        },
      )
    } else {
      new Notice(this.tv("notices.taskNotSelected", "No task selected"))
    }
  }

  async resetSelectedTask(): Promise<void> {
    if (this.selectedTaskInstance) {
      await this.resetTaskToIdle(this.selectedTaskInstance)
      this.clearTaskSelection()
    } else {
      new Notice(this.tv("notices.taskNotSelected", "No task selected"))
    }
  }

  showTodayTasks(): void {
    const today = new Date()
    this.currentDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    )

    // DayStateのキャッシュをクリアして、今日の日付で確実に再読み込みされるようにする
    this.currentDayStateKey = null
    this.currentDayState = null

    // カレンダー表示（日付ラベル）を更新
    const dateLabel = this.containerEl.querySelector(
      ".date-nav-label",
    ) as HTMLElement
    if (dateLabel) {
      this.updateDateLabel(dateLabel)
    }

    // タスクリストを再読み込みし、実行中タスクも復元
    this.reloadTasksAndRestore({ runBoundaryCheck: true }).then(() => {
      new Notice(
        this.tv('notices.showToday', "Showing today's tasks"),
      )
    })
  }

  reorganizeIdleTasks(): void {
    this.moveIdleTasksToCurrentTime()
    new Notice(this.tv("notices.idleReorganized", "Reorganized idle tasks"))
  }

  // ===========================================
  // Utility Methods
  // ===========================================

  private getTimeSlotKeys(): string[] {
    return ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
  }

  private sortTaskInstancesByTimeOrder(): void {
    if (this.useOrderBasedSort) {
      // Load saved orders
      const savedOrders = this.loadSavedOrders()
      this.applySavedOrders(savedOrders)
      this.ensureOrdersAcrossSlots(savedOrders, {
        forceDone: true,
        persist: false,
      })
    }
  }

  private applySavedOrders(savedOrders: Record<string, number>): void {
    this.taskInstances.forEach((inst) => {
      const key = this.getOrderKey(inst)
      if (!key) return
      const saved = savedOrders[key]
      if (typeof saved === "number" && Number.isFinite(saved)) {
        inst.order = saved
      }
    })
  }

  private ensureOrdersAcrossSlots(
    savedOrders: Record<string, number>,
    options: { forceDone?: boolean; persist?: boolean } = {},
  ): void {
    const slots = new Set<string>(["none", ...this.getTimeSlotKeys()])
    slots.forEach((slot) =>
      this.ensureOrdersForSlot(slot, savedOrders, options),
    )

    if (options.persist) {
      void this.saveTaskOrders()
    }
  }

  private ensureOrdersForSlot(
    slotKey: string,
    savedOrders: Record<string, number>,
    options: { forceDone?: boolean } = {},
  ): void {
    const instances = this.taskInstances.filter(
      (inst) => (inst.slotKey || "none") === slotKey,
    )
    if (instances.length === 0) return

    const done = instances.filter((inst) => inst.state === "done")
    const running = instances.filter(
      (inst) => inst.state === "running" || inst.state === "paused",
    )
    const idle = instances.filter((inst) => inst.state === "idle")

    let maxOrder = 0

    const assignSequential = (
      items: TaskInstance[],
      startOrder: number,
      step = 100,
    ) => {
      let cursor = startOrder
      items.forEach((inst) => {
        inst.order = cursor
        cursor += step
        maxOrder = Math.max(maxOrder, cursor - step)
      })
      return cursor
    }

    // Done tasks: always recompute by startTime when forceDone, otherwise fill gaps
    const shouldRecomputeDone =
      options.forceDone ||
      done.some((inst) => inst.order === undefined || inst.order === null)
    if (shouldRecomputeDone) {
      const sortedDone = [...done].sort((a, b) => {
        const ta = a.startTime ? a.startTime.getTime() : Infinity
        const tb = b.startTime ? b.startTime.getTime() : Infinity
        return ta - tb
      })
      assignSequential(sortedDone, 100)
    } else {
      done.forEach((inst) => {
        if (typeof inst.order === "number") {
          maxOrder = Math.max(maxOrder, inst.order)
        }
      })
    }

    // Running tasks: keep saved order, assign to missing ones after maxOrder
    running.forEach((inst) => {
      if (typeof inst.order === "number") {
        maxOrder = Math.max(maxOrder, inst.order)
      }
    })

    const runningMissing = running.filter(
      (inst) => inst.order === undefined || inst.order === null,
    )
    if (runningMissing.length > 0) {
      runningMissing.sort(
        (a, b) => (a.startTime?.getTime() ?? 0) - (b.startTime?.getTime() ?? 0),
      )
      assignSequential(runningMissing, maxOrder + 100)
    }

    // Idle tasks: apply saved order where available; assign the rest by scheduled time after current max
    idle.forEach((inst) => {
      if (typeof inst.order === "number") {
        maxOrder = Math.max(maxOrder, inst.order)
      }
    })

    const idleMissing = idle.filter(
      (inst) => inst.order === undefined || inst.order === null,
    )
    if (idleMissing.length > 0) {
      idleMissing.sort((a, b) => {
        const ta = a?.task?.scheduledTime
        const tb = b?.task?.scheduledTime
        if (!ta && !tb)
          return (a.task?.title || "").localeCompare(b.task?.title || "")
        if (!ta) return 1
        if (!tb) return -1
        const [ha, ma] = ta.split(":").map((n) => parseInt(n, 10))
        const [hb, mb] = tb.split(":").map((n) => parseInt(n, 10))
        return ha * 60 + ma - (hb * 60 + mb)
      })
      assignSequential(idleMissing, maxOrder + 100)
    }
  }

  private async saveTaskOrders(): Promise<void> {
    await this.ensureDayStateForCurrentDate()
    const dateStr = this.getCurrentDateString()
    const dayState = this.getCurrentDayState()

    const orders: Record<string, number> = {}
    this.taskInstances.forEach((inst) => {
      if (inst.order === undefined || inst.order === null) return
      const key = this.getOrderKey(inst)
      if (!key) return
      orders[key] = inst.order as number
    })

    if (
      Array.isArray(dayState.duplicatedInstances) &&
      dayState.duplicatedInstances.length > 0
    ) {
      dayState.duplicatedInstances = dayState.duplicatedInstances.map((dup) => {
        if (!dup || !dup.instanceId) return dup
        const inst = this.taskInstances.find(
          (i) => i.instanceId === dup.instanceId,
        )
        if (!inst) return dup
        return {
          ...dup,
          slotKey: inst.slotKey,
          originalSlotKey: inst.originalSlotKey ?? dup.originalSlotKey,
        }
      })
    }

    dayState.orders = orders
    await this.persistDayState(dateStr)
  }

  private loadSavedOrders(): Record<string, number> {
    const dateStr = this.getCurrentDateString()
    const state = this.dayStateCache.get(dateStr)
    if (!state || !state.orders) {
      return {}
    }

    const raw = state.orders
    const normalized: Record<string, number> = {}
    let mutated = false

    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        normalized[key] = value
        continue
      }

      if (value && typeof value === "object") {
        const valueRecord = value as { order?: unknown; slot?: unknown }
        const order = Number(valueRecord.order)
        if (!Number.isFinite(order)) continue
        const slot =
          typeof valueRecord.slot === "string" ? valueRecord.slot : "none"
        const normalizedKey = key.includes("::") ? key : `${key}::${slot}`
        normalized[normalizedKey] = order
        mutated = true
      }
    }

    if (mutated || Object.values(raw).some((v) => typeof v !== "number")) {
      state.orders = normalized
      this.dayStateCache.set(dateStr, state)
      void this.persistDayState(dateStr)
    }

    return normalized
  }

  private getSavedOrderForSlot(
    inst: TaskInstance,
    slotKey: string,
    savedOrders: Record<string, number>,
  ): number | undefined {
    const originalSlot = inst.slotKey
    inst.slotKey = slotKey
    const key = this.getOrderKey(inst)
    inst.slotKey = originalSlot
    if (!key) return undefined
    return savedOrders[key]
  }

  private sortByOrder(instances: TaskInstance[]): TaskInstance[] {
    return instances.sort((a, b) => {
      // 1) State priority: done (top) -> running/paused -> idle
      const statePriority: Record<string, number> = {
        done: 0,
        running: 1,
        paused: 1,
        idle: 2,
      }
      const sa = statePriority[a.state] ?? 3
      const sb = statePriority[b.state] ?? 3
      if (sa !== sb) return sa - sb

      // 2) Order comparison
      const hasOrderA = a.order !== undefined && a.order !== null
      const hasOrderB = b.order !== undefined && b.order !== null
      if (hasOrderA && hasOrderB) {
        if (a.order! !== b.order!) return a.order! - b.order!
        // If equal, fall through to time-based tiebreaker
      } else if (hasOrderA && !hasOrderB) {
        return -1 // With order comes first
      } else if (!hasOrderA && hasOrderB) {
        return 1 // With order comes first
      }

      // 3) Fallback: time-based
      if (a.state === "done" && b.state === "done") {
        const ta = a.startTime ? a.startTime.getTime() : Infinity
        const tb = b.startTime ? b.startTime.getTime() : Infinity
        if (ta !== tb) return ta - tb
        return 0
      }

      // For running/idle/paused: use scheduledTime (HH:MM)
      const tA = a.task?.scheduledTime as string | undefined
      const tB = b.task?.scheduledTime as string | undefined
      if (!tA && !tB) return 0
      if (!tA) return 1
      if (!tB) return -1
      const [ha, ma] = tA.split(":").map((n) => parseInt(n, 10))
      const [hb, mb] = tB.split(":").map((n) => parseInt(n, 10))
      return ha * 60 + ma - (hb * 60 + mb)
    })
  }

  private async moveTaskToSlot(
    inst: TaskInstance,
    newSlot: string,
    stateInsertIndex?: number,
  ): Promise<void> {
    await this.ensureDayStateForCurrentDate()

    const targetSlot = newSlot || "none"
    const normalizedState = this.normalizeState(inst.state)

    const sameStateTasks = this.taskInstances
      .filter(
        (t) =>
          t !== inst &&
          (t.slotKey || "none") === targetSlot &&
          this.normalizeState(t.state) === normalizedState,
      )
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

    const insertIndex =
      stateInsertIndex !== undefined
        ? Math.max(0, Math.min(stateInsertIndex, sameStateTasks.length))
        : sameStateTasks.length

    const referenceTasks = [...sameStateTasks]
    inst.slotKey = targetSlot
    this.persistSlotAssignment(inst)
    const newOrder = this.calculateSimpleOrder(insertIndex, referenceTasks)
    inst.order = newOrder

    await this.saveTaskOrders()
    this.sortTaskInstancesByTimeOrder()
    this.renderTaskList()
  }

  private applyResponsiveClasses(): void {
    // Apply responsive classes based on pane width
    const width = this.containerEl.clientWidth
    const classList = this.containerEl.classList

    classList.remove("narrow", "medium", "wide")

    if (width < 400) {
      classList.add("narrow")
    } else if (width < 600) {
      classList.add("medium")
    } else {
      classList.add("wide")
    }
  }

  private setupResizeObserver(): void {
    const resizeObserver = new ResizeObserver(() => {
      this.applyResponsiveClasses()
    })

    resizeObserver.observe(this.containerEl)
  }

  private initializeNavigationEventListeners(): void {
    // Navigation toggle
    const drawerToggle = this.containerEl.querySelector(
      ".drawer-toggle",
    ) as HTMLElement
    if (drawerToggle) {
      drawerToggle.addEventListener("click", () => {
        this.toggleNavigation()
      })
    }

    // Overlay click to close
    if (this.navigationOverlay) {
      this.navigationOverlay.addEventListener("click", () => {
        this.closeNavigation()
      })
    }
  }

  private scheduleBoundaryCheck(): void {
    // Schedule boundary check for idle-task-auto-move feature
    if (this.boundaryCheckTimeout) {
      clearTimeout(this.boundaryCheckTimeout)
    }
    const now = new Date()
    const boundaries: TimeBoundary[] = [
      { hour: 0, minute: 0 },
      { hour: 8, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 0 },
    ]

    const next = calculateNextBoundary(now, boundaries)
    // Run 1s after boundary to avoid edge jitter
    const delay = Math.max(0, next.getTime() - now.getTime() + 1000)

    this.boundaryCheckTimeout = setTimeout(() => {
      this.checkBoundaryTasks()
      this.scheduleBoundaryCheck() // Reschedule
    }, delay)
  }

  private async checkBoundaryTasks(): Promise<void> {
    try {
      // Only act on today
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const viewDate = new Date(this.currentDate)
      viewDate.setHours(0, 0, 0, 0)
      if (viewDate.getTime() !== today.getTime()) return

      // Current slot based on now
      const currentSlot = getCurrentTimeSlot(new Date())
      const slots = this.getTimeSlotKeys()
      const currentIndex = slots.indexOf(currentSlot)
      if (currentIndex < 0) return // safety

      let moved = false
      this.taskInstances.forEach((inst) => {
        if (inst.state !== "idle") return
        const slot = inst.slotKey || "none"
        if (slot === "none") return
        const idx = slots.indexOf(slot)
        if (idx >= 0 && idx < currentIndex) {
          // Past slot → move into current slot
          inst.slotKey = currentSlot
          this.persistSlotAssignment(inst)
          moved = true
        }
      })

      if (moved) {
        // Recompute orders per spec and rerender
        this.sortTaskInstancesByTimeOrder()
        await this.saveTaskOrders()
        this.renderTaskList()
      }
    } catch (e) {
      // Fail-safe: don't crash view on timer
      console.error("[TaskChute] boundary move failed:", e)
    }
  }

  private updateTotalTasksCount(): void {
    // Persist the number of visible task instances into monthly dailySummary.totalTasks
    ;(async () => {
      try {
        const total = this.taskInstances.length
        const dateStr = this.getCurrentDateString()
        const [year, month] = dateStr.split("-")
        const monthString = `${year}-${month}`
        const logDataPath = this.plugin.pathManager.getLogDataPath()
        const logPath = `${logDataPath}/${monthString}-tasks.json`

        const file = this.app.vault.getAbstractFileByPath(logPath)
        let json: TaskLogSnapshot = { taskExecutions: {}, dailySummary: {} }
        if (file && file instanceof TFile) {
          try {
            const raw = await this.app.vault.read(file)
            json = raw ? this.parseTaskLog(raw) : json
          } catch {
            // ignore parse errors; fall back to empty snapshot
          }
        } else {
          await this.plugin.pathManager.ensureFolderExists(logDataPath)
        }

        const prev = json.dailySummary[dateStr] || {}
        if (typeof prev.totalTasks === "number" && prev.totalTasks === total) {
          return // no change
        }

        // Recompute derived fields conservatively
        const dayExec = json.taskExecutions[dateStr] ?? []
        const completedSet = new Set<string>()
        for (const entry of dayExec) {
          if (this.isExecutionCompleted(entry)) {
            completedSet.add(computeExecutionInstanceKey(entry))
          }
        }
        const completedTasks = completedSet.size

        const totalMinutes =
          prev.totalMinutes ||
          dayExec.reduce((sum: number, entry) => {
            const duration =
              typeof entry.durationSec === "number"
                ? entry.durationSec
                : typeof entry.duration === "number"
                ? entry.duration
                : 0
            return sum + Math.floor(duration / 60)
          }, 0)
        const procrastinatedTasks = Math.max(0, total - completedTasks)
        const completionRate = total > 0 ? completedTasks / total : 0

        json.dailySummary[dateStr] = {
          ...prev,
          totalMinutes,
          totalTasks: total,
          completedTasks,
          procrastinatedTasks,
          completionRate,
        }

        const payload = JSON.stringify(json, null, 2)
        if (file && file instanceof TFile) {
          await this.app.vault.modify(file, payload)
        } else {
          await this.app.vault.create(logPath, payload)
        }
      } catch {
        // Fail-safe: do not block UI
      }
    })()
  }

  private cleanupAutocompleteInstances(): void {
    if (this.autocompleteInstances) {
      this.autocompleteInstances.forEach((instance) => {
        if (instance && instance.cleanup) {
          instance.cleanup()
        }
      })
      this.autocompleteInstances = []
    }
  }

  private cleanupTimers(): void {
    // Legacy interval cleanup (no-op after TimerService)
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    if (this.boundaryCheckTimeout) {
      clearTimeout(this.boundaryCheckTimeout)
      this.boundaryCheckTimeout = null
    }

    if (this.renderDebounceTimer) {
      clearTimeout(this.renderDebounceTimer)
      this.renderDebounceTimer = null
    }

    // TimerService dispose
    this.timerService?.dispose()
    this.timerService = null
  }

  // Styles are provided by styles.css; dynamic CSS injection removed

  // ===========================================
  // Placeholder Methods (to be implemented)
  // ===========================================

  private async handleNavigationItemClick(
    section: "routine" | "review" | "log" | "project",
  ): Promise<void> {
    if (section === "log") {
      this.openLogModal()
      this.closeNavigation()
      return
    }
    if (section === "review") {
      await this.showReviewSection()
      this.closeNavigation()
      return
    }
    if (section === "routine") {
      try {
        new RoutineManagerModal(this.app, this.plugin).open()
      } catch (error) {
        console.error("[TaskChute] Failed to open RoutineManagerModal:", error)
        // フォールバック: 既存のリスト表示
        await this.renderRoutineList()
        this.openNavigation()
      }
      this.closeNavigation()
      return
    }
    const sectionLabel = this.tv(
      `navigation.${section}`,
      section,
    )
    new Notice(
      this.tv('notices.sectionWip', '{section} is under construction', {
        section: sectionLabel,
      }),
    )
  }

  // Render routine list with enabled toggle
  private async renderRoutineList(): Promise<void> {
    if (!this.navigationContent) return
    this.navigationContent.empty()

    const header = this.navigationContent.createEl("div", {
      cls: "routine-list-header",
    })
    header.createEl("h3", {
      text: this.tv("labels.routineList", "Routine list"),
    })
    const hint = this.navigationContent.createEl("div", {
      cls: "routine-list-hint",
    })
    hint.textContent = this.tv(
      "labels.routineToggleHelp",
      "Toggle routines on or off here. Edit details from each task's settings.",
    )

    const list = this.navigationContent.createEl("div", { cls: "routine-list" })

    // Collect all markdown files under task folder
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    const all = this.app.vault.getMarkdownFiles()
    const files = all.filter((f: TFile) =>
      f.path.startsWith(taskFolderPath + "/"),
    )

    // Sort by basename for stable view
    files.sort((a, b) => a.basename.localeCompare(b.basename, "ja"))

    let count = 0
    for (const file of files) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter
      if (!fm || fm.isRoutine !== true) continue
      count++
      const row = this.createRoutineRow(file, fm)
      list.appendChild(row)
    }

    if (count === 0) {
      const none = this.navigationContent.createEl("div", {
        cls: "routine-empty",
      })
      none.textContent = this.tv("status.noRoutineFound", "No routines found")
    }
  }

  private createRoutineRow(file: TFile, fm: RoutineTaskShape): HTMLElement {
    const row = document.createElement("div")
    row.className = "routine-row"

    row.createEl("div", { cls: "routine-title", text: file.basename })

    const typeBadge = row.createEl("span", { cls: "routine-type-badge" })
    const type = (fm.routine_type || "daily") as string
    const interval = Math.max(1, Number(fm.routine_interval || 1))
    typeBadge.textContent = this.getRoutineTypeLabel(type, interval, fm)

    const toggleWrap = row.createEl("label", { cls: "routine-enabled-toggle" })
    const toggle = toggleWrap.createEl("input", {
      type: "checkbox",
    }) as HTMLInputElement
    toggle.checked = fm.routine_enabled !== false
    toggle.title = this.tv('tooltips.toggleRoutine', 'Toggle enabled state')
    toggle.addEventListener("change", async () => {
      await this.updateRoutineEnabled(file, toggle.checked)
      // 反映のためリロード
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
      // 行の表示も更新
      const newFm = this.app.metadataCache.getFileCache(file)?.frontmatter || {}
      typeBadge.textContent = this.getRoutineTypeLabel(
        newFm.routine_type || "daily",
        Math.max(1, Number(newFm.routine_interval || 1)),
        newFm,
      )
    })

    // Edit button → opens existing modal
    const editBtn = row.createEl("button", {
      cls: "routine-edit-btn",
      text: this.tv("buttons.edit", "Edit"),
    })
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      // Build minimal task adapter for modal
      const task: RoutineTaskShape = {
        title: file.basename,
        isRoutine: true,
        scheduledTime: getScheduledTime(fm),
        routine_type: fm.routine_type || "daily",
        routine_interval: fm.routine_interval || 1,
        routine_enabled: fm.routine_enabled !== false,
        weekday: fm.routine_weekday ?? fm.weekday,
        weekdays: fm.weekdays,
        monthly_week:
          fm.routine_week !== undefined
            ? fm.routine_week === "last"
              ? "last"
              : Number(fm.routine_week) - 1
            : fm.monthly_week,
        monthly_weekday: fm.routine_weekday ?? fm.monthly_weekday,
      }
      this.showRoutineEditModal(task, editBtn)
    })

    return row
  }

  private getRoutineTypeLabel(
    type: string,
    interval: number,
    fm: RoutineTaskShape,
  ): string {
    const dayNames = this.getWeekdayNames()
    switch (type) {
      case "daily":
        return this.tv('labels.routineDailyLabel', 'Every {interval} day(s)', {
          interval,
        })
      case "weekly": {
        const wd =
          fm.routine_weekday ??
          fm.weekday ??
          (Array.isArray(fm.weekdays) ? fm.weekdays[0] : undefined)
        const dayLabel =
          typeof wd === "number"
            ? dayNames[wd]
            : this.tv('labels.routineDayUnset', 'No weekday set')
        return this.tv(
          'labels.routineWeeklyLabel',
          'Every {interval} week(s) on {day}',
          {
            interval,
            day: dayLabel,
          },
        )
      }
      case "monthly": {
        const w =
          fm.routine_week ??
          (typeof fm.monthly_week === "number"
            ? fm.monthly_week + 1
            : fm.monthly_week === "last"
            ? "last"
            : undefined)
        const wd = fm.routine_weekday ?? fm.monthly_weekday
        const weekLabel =
          w === "last"
            ? this.tv('labels.routineWeekLast', 'Last week')
            : typeof w === "number"
            ? this.tv('labels.routineWeekNth', 'Week {week}', { week: w })
            : ''
        const dayLabel =
          typeof wd === "number"
            ? dayNames[wd]
            : this.tv('labels.routineDayUnset', 'No weekday set')
        const raw = this.tv(
          'labels.routineMonthlyLabel',
          'Every {interval} month(s) on {week} {day}',
          {
            interval,
            week: weekLabel,
            day: dayLabel,
          },
        )
        return raw.replace(/\s{2,}/g, ' ').trim()
      }
      case "weekdays":
        return this.tv('status.weekdaysOnly', 'Weekdays only')
      case "weekends":
        return this.tv('status.weekendsOnly', 'Weekends only')
      default:
        return type
    }
  }

  private async updateRoutineEnabled(
    file: TFile,
    enabled: boolean,
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.routine_enabled = enabled
      return frontmatter
    })
  }

  // Show Daily Review in right split
  private async showReviewSection(): Promise<void> {
    try {
      // Determine date string; clamp future to today
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(
        today.getMonth() + 1,
      ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
      const selectedStr = this.getCurrentDateString()
      const reviewDate = new Date(selectedStr)
      const dateStr = reviewDate > new Date(todayStr) ? todayStr : selectedStr

      const review = new ReviewService(this.plugin)
      const file = await review.ensureReviewFile(dateStr)
      await review.openInSplit(file, this.leaf)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.reviewDisplayFailed', 'Failed to display review: {message}', {
          message,
        }),
      )
    }
  }

  private openLogModal(): void {
    const overlay = document.createElement("div")
    overlay.className = "taskchute-log-modal-overlay"
    const content = overlay.createEl("div", {
      cls: "taskchute-log-modal-content",
    })
    const closeBtn = content.createEl("button", {
      cls: "log-modal-close",
      text: "×",
      attr: { title: t("common.close", "Close") },
    })
    closeBtn.addEventListener("click", () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    })

    const logView = new LogView(this.plugin, content)
    logView.render()

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      }
    })

    document.body.appendChild(overlay)
  }

  private async handleKeyboardShortcut(e: KeyboardEvent): Promise<void> {
    // Ignore when typing in inputs / editable fields
    const active = document.activeElement as HTMLElement | null
    if (
      active &&
      active !== document.body &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    ) {
      return
    }

    // Ignore when any modal/overlay is open
    if (
      document.querySelector(".modal") ||
      document.querySelector(".task-modal-overlay")
    )
      return

    if (!this.selectedTaskInstance) return

    switch ((e.key || "").toLowerCase()) {
      case "c":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          await this.duplicateInstance(this.selectedTaskInstance)
          this.clearTaskSelection()
        }
        break
      case "d":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          this.deleteSelectedTask()
        }
        break
      case "u":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          if (this.selectedTaskInstance.state !== "idle") {
            await this.resetTaskToIdle(this.selectedTaskInstance)
            this.clearTaskSelection()
          } else {
            new Notice(
              this.tv(
                "status.alreadyNotStarted",
                "This task is already not started",
              ),
            )
          }
        }
        break
    }
  }

  private selectTaskForKeyboard(
    inst: TaskInstance,
    taskItem: HTMLElement,
  ): void {
    this.selectedTaskInstance = inst

    // Clear previous selections
    this.containerEl
      .querySelectorAll(".task-item.keyboard-selected")
      .forEach((el) => el.classList.remove("keyboard-selected"))

    // Add selection to current item
    taskItem.classList.add("keyboard-selected")
  }

  private clearTaskSelection(): void {
    this.selectedTaskInstance = null
    this.containerEl
      .querySelectorAll(".task-item.keyboard-selected")
      .forEach((el) => el.classList.remove("keyboard-selected"))
  }

  private async deleteTask(inst: TaskInstance): Promise<void> {
    if (!inst) return

    // 非ルーチンタスクの削除処理
    if (!inst.task.isRoutine) {
      await this.deleteNonRoutineTask(inst)
    } else {
      // ルーチンタスクの削除処理
      await this.deleteRoutineTask(inst)
    }
  }

  private async deleteNonRoutineTask(inst: TaskInstance): Promise<void> {
    // 非ルーチンタスクの削除
    // 1) 実行ログの整合性: インスタンス単位の実行履歴を削除（存在すれば）
    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }
    // 2) インスタンス削除
    await this.deleteInstance(inst)
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<void> {
    // ルーチンタスクの削除もdeleteInstanceメソッドに統一
    // ただし、hidden routinesに追加する処理が必要
    const dateStr = this.getCurrentDateString()
    await this.ensureDayStateForCurrentDate()
    const dayState = this.getCurrentDayState()

    // 複製タスクかチェック
    const isDuplicated = this.isDuplicatedTask(inst)

    const alreadyHidden = dayState.hiddenRoutines.some(
      (h: HiddenRoutine | string) => {
        if (isDuplicated) {
          if (typeof h === "string") return false
          return (h as HiddenRoutine).instanceId === inst.instanceId
        }
        if (typeof h === "string") {
          return h === inst.task.path
        }
        return h.path === inst.task.path && !h.instanceId
      },
    )

    if (!alreadyHidden) {
      dayState.hiddenRoutines.push({
        path: inst.task.path,
        instanceId: isDuplicated ? inst.instanceId : null,
      })
      await this.persistDayState(dateStr)
    }

    // 実行履歴から削除
    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
    }

    // deleteInstanceを呼ぶ
    await this.deleteInstance(inst)
  }

  private isDuplicatedTask(inst: TaskInstance): boolean {
    const dayState = this.getCurrentDayState()
    return dayState.duplicatedInstances.some(
      (d) => d.instanceId === inst.instanceId,
    )
  }

  private async deleteTaskLogsByInstanceId(
    taskPath: string,
    instanceId: string,
  ): Promise<number> {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const [year, month] = this.getCurrentDateString().split("-")
      const monthString = `${year}-${month}`
      const logPath = `${logDataPath}/${monthString}-tasks.json`

      const logFile = this.app.vault.getAbstractFileByPath(logPath)
      if (!logFile || !(logFile instanceof TFile)) {
        return 0
      }

      const content = await this.app.vault.read(logFile)
      const monthlyLog = this.parseTaskLog(content)

      let deletedCount = 0
      for (const dateKey of Object.keys(monthlyLog.taskExecutions)) {
        const dayExecutions = monthlyLog.taskExecutions[dateKey] ?? []
        const beforeLength = dayExecutions.length
        monthlyLog.taskExecutions[dateKey] = dayExecutions.filter(
          (exec) => exec.instanceId !== instanceId,
        )
        deletedCount += beforeLength - monthlyLog.taskExecutions[dateKey].length
      }

      if (deletedCount > 0) {
        await this.app.vault.modify(
          logFile,
          JSON.stringify(monthlyLog, null, 2),
        )
      }

      return deletedCount
    } catch (error) {
      console.error("Failed to delete task logs:", error)
      return 0
    }
  }

  private showTaskContextMenu(e: MouseEvent, inst: TaskInstance): void {
    new Notice(
      this.tv("status.contextMenuWip", "Context menu is under construction"),
    )
  }

  private handleDragOver(
    e: DragEvent,
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    e.preventDefault()

    // Clear previous classes
    this.clearDragoverClasses(taskItem)

    // Don't show indicators for completed tasks
    if (inst.state === "done") {
      taskItem.classList.add("dragover-invalid")
      return
    }

    // Calculate drop position based on mouse position
    const rect = taskItem.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height
    const isBottomHalf = y > height / 2

    // Add appropriate visual feedback
    if (isBottomHalf) {
      taskItem.classList.add("dragover-bottom")
    } else {
      taskItem.classList.add("dragover-top")
    }
  }

  private clearDragoverClasses(taskItem: HTMLElement): void {
    taskItem.classList.remove(
      "dragover",
      "dragover-top",
      "dragover-bottom",
      "dragover-invalid",
    )
  }

  private handleDrop(
    e: DragEvent,
    taskItem: HTMLElement,
    targetInst: TaskInstance,
  ): void {
    const data = e.dataTransfer?.getData("text/plain")
    if (!data) {
      this.clearDragoverClasses(taskItem)
      return
    }

    const [sourceSlot, sourceIdx] = data.split("::")
    const targetSlot = targetInst.slotKey || "none"

    // Find the source instance
    const sourceInst = this.taskInstances.find((inst) => {
      const instSlot = inst.slotKey || "none"
      const slotInstances = this.taskInstances.filter(
        (t) => (t.slotKey || "none") === instSlot,
      )
      const sortedSlotInstances = this.sortByOrder(slotInstances)
      const idx = sortedSlotInstances.indexOf(inst)
      return instSlot === sourceSlot && idx === parseInt(sourceIdx)
    })

    if (!sourceInst || sourceInst.state === "done") {
      this.clearDragoverClasses(taskItem)
      return
    }

    // Calculate drop position
    const rect = taskItem.getBoundingClientRect()
    const y = e.clientY - rect.top
    const isBottomHalf = y > rect.height / 2

    // Get tasks in target slot
    const targetSlotTasks = this.taskInstances.filter(
      (t) => (t.slotKey || "none") === targetSlot,
    )
    const sortedTargetTasks = this.sortByOrder(targetSlotTasks)
    const targetWithoutSource = sortedTargetTasks.filter(
      (t) => t !== sourceInst,
    )

    // Find target position
    const targetIndex = sortedTargetTasks.indexOf(targetInst)
    let newPosition = isBottomHalf ? targetIndex + 1 : targetIndex

    const sourcePriority = this.getStatePriority(sourceInst.state)
    let minAllowed = 0
    for (const task of sortedTargetTasks) {
      if (this.getStatePriority(task.state) < sourcePriority) {
        minAllowed++
      }
    }

    let boundaryAfter = sortedTargetTasks.length
    for (let i = 0; i < sortedTargetTasks.length; i++) {
      if (this.getStatePriority(sortedTargetTasks[i].state) > sourcePriority) {
        boundaryAfter = i
        break
      }
    }

    if (newPosition < minAllowed) {
      new Notice(
        this.tv(
          "notices.cannotPlaceAboveCompleted",
          "Cannot place above running or completed tasks",
        ),
      )
      this.clearDragoverClasses(taskItem)
      return
    }

    if (newPosition > boundaryAfter) {
      newPosition = boundaryAfter
    }

    // If moving within the same slot, adjust position
    if (sourceSlot === targetSlot) {
      const sourceIndex = sortedTargetTasks.indexOf(sourceInst)
      if (sourceIndex < newPosition) {
        newPosition--
      }
    }

    const clampedPosition = Math.max(
      0,
      Math.min(newPosition, targetWithoutSource.length),
    )
    let stateInsertIndex = 0
    const normalizedSourceState = this.normalizeState(sourceInst.state)
    for (let i = 0; i < clampedPosition; i++) {
      const candidate = targetWithoutSource[i]
      if (this.normalizeState(candidate.state) === normalizedSourceState) {
        stateInsertIndex++
      }
    }

    void this.moveTaskToSlot(sourceInst, targetSlot, stateInsertIndex).catch(
      (error) => {
        console.error("[TaskChute]", "moveTaskToSlot failed", error)
      },
    )
    this.clearDragoverClasses(taskItem)
  }

  private handleSlotDrop(e: DragEvent, slot: string): void {
    const data = e.dataTransfer?.getData("text/plain")
    if (!data) return

    const [sourceSlot, sourceIdx] = data.split("::")

    // Find the source instance
    const sourceInst = this.taskInstances.find((inst) => {
      const instSlot = inst.slotKey || "none"
      const slotInstances = this.taskInstances.filter(
        (t) => (t.slotKey || "none") === instSlot,
      )
      const sortedSlotInstances = this.sortByOrder(slotInstances)
      const idx = sortedSlotInstances.indexOf(inst)
      return instSlot === sourceSlot && idx === parseInt(sourceIdx)
    })

    if (!sourceInst || sourceInst.state === "done") return

    // Move to the end of the target slot
    const normalizedSlot = slot || "none"
    const normalizedState = this.normalizeState(sourceInst.state)
    const sameStateTasks = this.taskInstances.filter(
      (t) =>
        t !== sourceInst &&
        (t.slotKey || "none") === normalizedSlot &&
        this.normalizeState(t.state) === normalizedState,
    )
    const insertIndex = sameStateTasks.length
    void this.moveTaskToSlot(sourceInst, slot, insertIndex)
  }

  private toggleNavigation(): void {
    this.navigationState.isOpen = !this.navigationState.isOpen

    if (this.navigationState.isOpen) {
      this.openNavigation()
    } else {
      this.closeNavigation()
    }
  }

  private openNavigation(): void {
    this.navigationPanel.classList.remove("navigation-panel-hidden")
    this.navigationOverlay.classList.remove("navigation-overlay-hidden")
  }

  private closeNavigation(): void {
    this.navigationPanel.classList.add("navigation-panel-hidden")
    this.navigationOverlay.classList.add("navigation-overlay-hidden")
  }

  private async setRoutineTask(
    task: RoutineTaskShape,
    button: HTMLElement,
    scheduledTime: string,
  ): Promise<void> {
    try {
      const fallbackTitle =
        task.title ||
        (typeof task.path === "string"
          ? task.path.split("/").pop()?.replace(/\.md$/u, "")
          : undefined) ||
        "Untitled Task"
      // Prefer existing path to avoid folder mismatch
      const primaryPath = task.path || ""
      let file = primaryPath
        ? this.app.vault.getAbstractFileByPath(primaryPath)
        : null
      if (!file) {
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        const fallbackPath = `${taskFolderPath}/${fallbackTitle}.md`
        file = this.app.vault.getAbstractFileByPath(fallbackPath)
      }

      if (!file || !(file instanceof TFile)) {
        new Notice(
          this.tv('project.fileMissing', 'Task file "{title}.md" not found', {
            title: fallbackTitle,
          }),
        )
        return
      }

      // ルーチンタスクとして設定
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.isRoutine = true
        // Phase 2: 新規タスクは新形式を優先
        setScheduledTime(frontmatter, scheduledTime, { preferNew: true })
        frontmatter.routine_type = "daily"
        const y = this.currentDate.getFullYear()
        const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
        const d = this.currentDate.getDate().toString().padStart(2, "0")
        frontmatter.routine_start = `${y}-${m}-${d}`
        delete frontmatter.routine_end
        return frontmatter
      })

      // 状態更新
      task.isRoutine = true
      task.scheduledTime = scheduledTime
      button.classList.add("active")
      button.setAttribute(
        "title",
        this.tv('tooltips.routineScheduled', 'Routine task (starts at {time})', {
          time: scheduledTime,
        }),
      )

      // タスク情報を再取得し、実行中タスクの表示も復元
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
      new Notice(
        this.tv(
          'notices.routineSetSuccess',
          'Set "{title}" as a routine task (starts at {time})',
          {
            title: task.title ?? fallbackTitle,
            time: scheduledTime,
          },
        ),
      )
    } catch (error: unknown) {
      console.error("Failed to set routine task:", error)
      const msg = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.routineSetFailed', 'Failed to set routine task: {message}', {
          message: msg,
        }),
      )
    }
  }

  private async setRoutineTaskWithDetails(
    task: RoutineTaskShape,
    button: HTMLElement,
    scheduledTime: string,
    routineType: string,
    details: {
      weekdays?: number[]
      monthly_week?: number | "last"
      monthly_weekday?: number
      interval?: number
      enabled?: boolean
    },
  ): Promise<void> {
    try {
      const fallbackTitle =
        task.title ||
        (typeof task.path === "string"
          ? task.path.split("/").pop()?.replace(/\.md$/u, "")
          : undefined) ||
        "Untitled Task"
      // Prefer existing path to avoid folder mismatch
      const primaryPath = task.path || ""
      let file = primaryPath
        ? this.app.vault.getAbstractFileByPath(primaryPath)
        : null
      if (!file) {
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        const fallbackPath = `${taskFolderPath}/${fallbackTitle}.md`
        file = this.app.vault.getAbstractFileByPath(fallbackPath)
      }

      if (!file || !(file instanceof TFile)) {
        new Notice(
          this.tv('project.fileMissing', 'Task file "{title}.md" not found', {
            title: fallbackTitle,
          }),
        )
        return
      }

      // ルーチンタスクとして設定
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const y = this.currentDate.getFullYear();
        const m = (this.currentDate.getMonth() + 1).toString().padStart(2, '0');
        const d = this.currentDate.getDate().toString().padStart(2, '0');

        const changes: Record<string, unknown> = {
          isRoutine: true,
          routine_type: routineType,
          routine_enabled: details.enabled !== false,
          routine_interval: Math.max(1, details.interval || 1),
          routine_start: `${y}-${m}-${d}`,
        };

        setScheduledTime(changes, scheduledTime, { preferNew: true });

        const cleaned = TaskValidator.cleanupOnRoutineChange(frontmatter, changes);
        delete cleaned.routine_end;
        delete cleaned.weekday;
        delete cleaned.weekdays;
        delete cleaned.monthly_week;
        delete cleaned.monthly_weekday;
        delete cleaned.routine_week;
        delete cleaned.routine_weekday;

        applyRoutineFrontmatterMerge(frontmatter as RoutineFrontmatter, cleaned);

        if (routineType === 'weekly') {
          if (details.weekdays && details.weekdays.length > 0) {
            frontmatter.routine_weekday = details.weekdays[0];
          }
        } else if (routineType === 'monthly') {
          if (details.monthly_week !== undefined && details.monthly_weekday !== undefined) {
            const weekValue =
              details.monthly_week === 'last'
                ? 'last'
                : (details.monthly_week as number) + 1;
            frontmatter.routine_week = weekValue;
            frontmatter.routine_weekday = details.monthly_weekday;
          }
        }

        return frontmatter;
      })

      // 状態更新
      task.isRoutine = true
      task.scheduledTime = scheduledTime
      task.routine_type = routineType
      task.routine_interval = Math.max(1, details.interval || 1)
      task.routine_enabled = details.enabled !== false

      // タイプに応じて詳細情報も更新
      if (routineType === "weekly") {
        const selected = Array.isArray(details.weekdays) ? details.weekdays.filter((value) => Number.isInteger(value)) : []
        task.weekdays = selected
        if (selected.length > 0) {
          task.weekday = selected[0]
          task.routine_weekday = selected[0]
        } else {
          delete task.weekday
          delete task.routine_weekday
        }
        delete task.routine_week
        delete task.monthly_week
        delete task.monthly_weekday
      } else if (routineType === "monthly") {
        const routineWeek = details.monthly_week === 'last'
          ? 'last'
          : typeof details.monthly_week === 'number'
            ? details.monthly_week + 1
            : undefined
        if (routineWeek !== undefined) {
          task.routine_week = routineWeek
        } else {
          delete task.routine_week
        }
        if (details.monthly_week !== undefined) {
          task.monthly_week = details.monthly_week
        } else {
          delete task.monthly_week
        }
        if (typeof details.monthly_weekday === 'number') {
          task.monthly_weekday = details.monthly_weekday
          task.routine_weekday = details.monthly_weekday
        } else {
          delete task.monthly_weekday
          delete task.routine_weekday
        }
        delete task.weekday
        delete task.weekdays
      } else {
        delete task.weekday
        delete task.weekdays
        delete task.monthly_week
        delete task.monthly_weekday
        delete task.routine_week
        delete task.routine_weekday
      }

      button.classList.add("active")

      // ツールチップテキストを生成
      let tooltipText = this.tv(
        'tooltips.routineScheduled',
        'Routine task (starts at {time})',
        { time: scheduledTime },
      )
      const intervalValue = task.routine_interval || details.interval || 1
      switch (routineType) {
        case "daily":
          tooltipText += ` - ${this.tv(
            'labels.routineDailyLabel',
            'Every {interval} day(s)',
            { interval: intervalValue },
          )}`
          break
        case "weekdays":
          tooltipText += this.tv(
            "lists.weekdaysOnlySuffix",
            " - Weekdays only",
          )
          break
        case "weekends":
          tooltipText += this.tv(
            "lists.weekendsOnlySuffix",
            " - Weekends only",
          )
          break
        case "weekly":
          if (details.weekdays) {
            const dayNames = this.getWeekdayNames()
            const selectedDay =
              typeof details.weekdays[0] === "number"
                ? dayNames[details.weekdays[0]]
                : this.tv('labels.routineDayUnset', 'No weekday set')
            tooltipText += ` - ${this.tv(
              'labels.routineWeeklyLabel',
              'Every {interval} week(s) on {day}',
              {
                interval: intervalValue,
                day: selectedDay,
              },
            )}`
          }
          break
        case "monthly":
          if (
            details.monthly_week !== undefined &&
            details.monthly_weekday !== undefined
          ) {
            const dayNames = this.getWeekdayNames()
            const weekLabel =
              details.monthly_week === "last"
                ? this.tv('labels.routineWeekLast', 'Last week')
                : this.tv('labels.routineWeekNth', 'Week {week}', {
                    week: (details.monthly_week as number) + 1,
                  })
            const dayLabel =
              typeof details.monthly_weekday === "number"
                ? dayNames[details.monthly_weekday]
                : this.tv('labels.routineDayUnset', 'No weekday set')
            const monthlyLabel = this.tv(
              'labels.routineMonthlyLabel',
              'Every {interval} month(s) on {week} {day}',
              {
                interval: intervalValue,
                week: weekLabel,
                day: dayLabel,
              },
            )
            tooltipText += ` - ${monthlyLabel.replace(/\s{2,}/g, ' ').trim()}`
          }
          break
      }

      button.setAttribute("title", tooltipText)

      // タスク情報を再取得し、実行中タスクの表示も復元
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
      new Notice(
        this.tv(
          'notices.routineSetSuccess',
          'Set "{title}" as a routine task (starts at {time})',
          {
            title: task.title ?? fallbackTitle,
            time: scheduledTime,
          },
        ),
      )
    } catch (error: unknown) {
      console.error("Failed to set routine task:", error)
      const msg = error instanceof Error ? error.message : String(error)
      new Notice(
        this.tv('notices.routineSetFailed', 'Failed to set routine task: {message}', {
          message: msg,
        }),
      )
    }
  }

  private async deleteInstanceWithConfirm(inst: TaskInstance): Promise<void> {
    const confirmed = await this.showDeleteConfirmDialog(inst)
    if (confirmed) {
      await this.deleteInstance(inst)
    }
  }

  private showDeleteConfirmDialog(inst: TaskInstance): Promise<boolean> {
    return new Promise((resolve) => {
      const displayTitle = this.getInstanceDisplayTitle(inst)
      const modal = document.createElement("div")
      modal.className = "task-modal-overlay"
      const modalContent = modal.createEl("div", { cls: "task-modal-content" })

      modalContent.createEl("h3", {
        text: this.tv('forms.deleteConfirmTitle', 'Confirm task deletion'),
      })
      modalContent.createEl("p", {
        text: this.tv('forms.deleteConfirmBody', 'Delete "{task}"?', {
          task: displayTitle,
        }),
      })

      const buttonContainer = modalContent.createEl("div", {
        cls: "modal-button-container",
      })

      const confirmButton = buttonContainer.createEl("button", {
        text: t("common.delete", "Delete"),
        cls: "mod-cta",
      })

      const cancelButton = buttonContainer.createEl("button", {
        text: t("common.cancel", "Cancel"),
      })

      confirmButton.addEventListener("click", () => {
        modal.remove()
        resolve(true)
      })

      cancelButton.addEventListener("click", () => {
        modal.remove()
        resolve(false)
      })

      document.body.appendChild(modal)
    })
  }

  private async deleteInstance(inst: TaskInstance): Promise<void> {
    try {
      const displayTitle = this.getInstanceDisplayTitle(inst)
      await this.ensureDayStateForCurrentDate()
      // インスタンスをリストから削除
      const index = this.taskInstances.indexOf(inst)
      if (index > -1) {
        this.taskInstances.splice(index, 1)
      }

      // 削除状態を保存
      const dateStr = this.getCurrentDateString()
      const dayState = this.getCurrentDayState()
      const deletedInstances = this.getDeletedInstances(dateStr)
      const isDup = this.isDuplicatedTask(inst)
      if (isDup) {
        // 複製インスタンスは instance 単位で削除（元は残す）
        const deletion: DeletedInstance = {
          instanceId: inst.instanceId,
          path: inst.task.path,
          deletionType: "temporary",
          timestamp: Date.now(),
        }
        deletedInstances.push(deletion)
        // 複製メタデータからも除去
        dayState.duplicatedInstances = dayState.duplicatedInstances.filter(
          (dup) => dup.instanceId !== inst.instanceId,
        )
      } else {
        if (!inst.task.isRoutine) {
          // 非ルーチン: 通常はパス単位（permanent）。ただしパスが不明/不正なら instance 単位にフォールバック
          const p = inst.task.path
          const isValidPath =
            typeof p === "string" && p.length > 0 && !/\/undefined\.md$/.test(p)
          if (isValidPath) {
            const deletion: DeletedInstance = {
              path: p,
              deletionType: "permanent",
              timestamp: Date.now(),
            }
            deletedInstances.push(deletion)
          } else {
            const deletion: DeletedInstance = {
              instanceId: inst.instanceId,
              path: p || "",
              deletionType: "temporary",
              timestamp: Date.now(),
            }
            deletedInstances.push(deletion)
          }
        } else {
          // ルーチン: instance 単位（今日のみ非表示）
          const deletion: DeletedInstance = {
            instanceId: inst.instanceId,
            path: inst.task.path,
            deletionType: "temporary",
            timestamp: Date.now(),
          }
          deletedInstances.push(deletion)
        }
      }
      this.saveDeletedInstances(dateStr, deletedInstances)
      await this.persistDayState(dateStr)

      // 非ルーチンタスクの場合、同じパスの他のインスタンスがなければファイルも削除
      if (!inst.task.isRoutine) {
        const samePathInstances = this.taskInstances.filter(
          (i) => i.task.path === inst.task.path,
        )

        if (samePathInstances.length === 0 && inst.task.file) {
          // 最後のインスタンスの場合、ファイルも削除
          this.tasks = this.tasks.filter((t) => t.path !== inst.task.path)
          await this.app.fileManager.trashFile(inst.task.file, true)
          new Notice(this.tv('notices.taskDeletedPermanent', 'Permanently deleted the task.'))
        } else {
          new Notice(this.tv('notices.taskRemovedFromToday', 'Removed task from today.'))
        }
      } else {
        new Notice(
          this.tv('notices.taskRemovedFromTodayWithTitle', 'Removed "{title}" from today.', {
            title: displayTitle,
          }),
        )
      }

      // UIを更新
      this.renderTaskList()
    } catch (error) {
      console.error("Failed to delete instance:", error)
      new Notice(this.tv("notices.taskDeleteFailed", "Failed to delete task"))
    }
  }

  private async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    try {
      const displayTitle = this.getInstanceDisplayTitle(inst)
      // 状態をidleにリセット
      inst.state = "idle"
      inst.startTime = undefined
      inst.stopTime = undefined

      // もし以前に完了してログへ書かれていた場合、当日の実行ログを削除
      // （再起動後に "done" として復活するのを防止）
      if (inst.instanceId) {
        await this.removeTaskLogForInstanceOnCurrentDate(inst.instanceId)
      }

      // 永続化された実行中タスクからも除外しておく（再起動で勝手に復活しないように）
      await this.saveRunningTasksState()

      // UIを更新
      this.renderTaskList()

      new Notice(
        this.tv('notices.restoredToIdle', 'Moved "{title}" back to idle', {
          title: displayTitle,
        }),
      )
    } catch (error) {
      console.error("Failed to reset task:", error)
      new Notice(this.tv("notices.taskResetFailed", "Failed to reset task"))
    }
  }

  private async showProjectSettingsModal(
    inst: TaskInstance,
    tooltip: HTMLElement,
  ): Promise<void> {
    // ツールチップを閉じる
    if (tooltip) {
      tooltip.remove()
    }

    const displayTitle = this.getInstanceDisplayTitle(inst)
    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl(
      "h3",
      {
        text: this.tv(
          'project.settingsTitle',
          `Project settings for "${displayTitle}"`,
          { title: displayTitle },
        ),
      },
    )

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: t("common.close", "Close") },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // プロジェクト選択
    const projectGroup = form.createEl("div", { cls: "form-group" })
    projectGroup.createEl("label", {
      text: this.tv('project.selectLabel', 'Select project:'),
      cls: "form-label",
    })
    const projectSelect = projectGroup.createEl("select", {
      cls: "form-select",
    }) as HTMLSelectElement

    // プロジェクトリストを取得してオプションを追加
    const projects = await this.getAvailableProjects()

    // 「プロジェクトなし」オプション
    projectSelect.createEl("option", {
      value: "",
      text: this.tv('project.none', 'No project'),
    })

    projects.forEach((project) => {
      projectSelect.createEl("option", {
        value: project,
        text: project,
      })
    })

    // 現在のプロジェクトを選択
    if (inst.task.project) {
      projectSelect.value = inst.task.project
    }

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: t("common.cancel", "Cancel"),
    })
    buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: this.tv("buttons.save", "Save"),
    })

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const selectedProject = projectSelect.value

      // プロジェクトを更新
      await this.updateTaskProject(inst, selectedProject)
      document.body.removeChild(modal)
    })

    // モーダルを表示
    document.body.appendChild(modal)
  }

  private async getAvailableProjects(): Promise<string[]> {
    try {
      const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()
      const projectFolder =
        this.app.vault.getAbstractFileByPath(projectFolderPath)

      if (!projectFolder || !("children" in projectFolder)) {
        return []
      }

      const projects: string[] = []
      for (const file of projectFolder.children) {
        if (file instanceof TFile && file.extension === "md") {
          projects.push(file.basename)
        }
      }

      return projects
    } catch (error) {
      console.error("Failed to get projects:", error)
      return []
    }
  }

  private async updateTaskProject(
    inst: TaskInstance,
    projectName: string,
  ): Promise<void> {
    try {
      const displayTitle = this.getInstanceDisplayTitle(inst)
      let file: TFile | null = inst.task.file instanceof TFile ? inst.task.file : null
      if (!file && inst.task.path) {
        const byPath = this.app.vault.getAbstractFileByPath(inst.task.path)
        file = byPath instanceof TFile ? byPath : null
      }
      if (!file) {
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        const fallbackBase = inst.task.name || displayTitle
        const fallbackPath = `${taskFolderPath}/${fallbackBase}.md`
        const byFallback = this.app.vault.getAbstractFileByPath(fallbackPath)
        file = byFallback instanceof TFile ? byFallback : null
      }

      if (!file) {
        new Notice(
          this.tv('project.fileMissing', 'Task file "{title}.md" not found', {
            title: displayTitle,
          }),
        )
        return
      }

      // プロジェクトを更新
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (projectName) {
          // Save as wikilink only (no project_path)
          frontmatter.project = `[[${projectName}]]`
        } else {
          delete frontmatter.project
          // Do not write project_path in any case
          delete frontmatter.project_path
        }
        return frontmatter
      })

      // タスクオブジェクトを更新
      inst.task.project = projectName || undefined
      // Compute path using settings (PathManager)
      const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()
      inst.task.projectPath = projectName
        ? `${projectFolderPath}/${projectName}.md`
        : undefined
      inst.task.projectTitle = projectName || undefined

      // UIを更新
      this.renderTaskList()

      const message = projectName
        ? this.tv(
            'project.linked',
            'Linked "{title}" to {project}',
            { title: displayTitle, project: projectName },
          )
        : this.tv(
            'project.unlinked',
            'Removed project link from "{title}"',
            { title: displayTitle },
          )
      new Notice(message)
    } catch (error) {
      console.error("Failed to update project:", error)
      new Notice(
        this.tv("notices.projectUpdateFailed", "Failed to update project"),
      )
    }
  }

  private moveIdleTasksToCurrentTime(): void {
    new Notice(
      this.tv(
        "status.idleFeatureWip",
        "Idle task reordering is under construction",
      ),
    )
  }

  private async showAddTaskModal(): Promise<void> {
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"
    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", {
      text: this.tv('addTask.title', 'Add new task'),
    })

    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
    })

    const form = modalContent.createEl("form", { cls: "task-form" })

    const nameGroup = form.createEl("div", { cls: "form-group" })
    nameGroup.createEl("label", {
      text: this.tv('addTask.nameLabel', 'Task name:'),
      cls: "form-label",
    })
    const nameInput = nameGroup.createEl("input", {
      type: "text",
      cls: "form-input",
      placeholder: this.tv('addTask.namePlaceholder', 'Enter task name'),
    }) as HTMLInputElement

    const warningMessage = nameGroup.createEl("div", {
      cls: "task-name-warning hidden",
      attr: { role: "alert", "aria-live": "polite" },
    })

    let autocomplete: TaskNameAutocomplete | null = null
    let cleanupAutocomplete: (() => void) | null = null

    try {
      autocomplete = new TaskNameAutocomplete(
        this.plugin,
        nameInput,
        nameGroup,
        this,
      )
      await autocomplete.initialize()
      const cleanup = () => {
        if (autocomplete && typeof autocomplete.destroy === "function") {
          autocomplete.destroy()
        }
      }
      cleanupAutocomplete = cleanup
      this.autocompleteInstances.push({ cleanup })
    } catch (e) {
      console.error("[TaskChute] autocomplete init failed:", e)
    }

    const estimatedMinutes = 30

    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: t("common.cancel", "Cancel"),
    }) as HTMLButtonElement
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: this.tv("buttons.save", "Save"),
    }) as HTMLButtonElement

    const validationControls = this.setupTaskNameValidation(
      nameInput,
      saveButton,
      warningMessage,
    )

    const closeModal = () => {
      cleanupAutocomplete?.()
      validationControls.dispose()
      if (modal.parentElement) {
        modal.parentElement.removeChild(modal)
      }
    }

    closeButton.addEventListener("click", closeModal)
    cancelButton.addEventListener("click", closeModal)

    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        closeModal()
      }
    })

    nameInput.addEventListener("autocomplete-selected", () => {
      validationControls.runValidation()
    })

    nameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return

      if (
        autocomplete?.isSuggestionsVisible?.() &&
        autocomplete.hasActiveSelection?.()
      ) {
        return
      }

      const validation = this.getTaskNameValidator().validate(nameInput.value)
      if (!validation.isValid) {
        event.preventDefault()
        this.highlightWarning(warningMessage)
      }
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const taskName = nameInput.value.trim()

      if (!taskName) {
        new Notice(
          this.tv("forms.nameRequired", "Please enter a task name"),
        )
        return
      }

      if (!this.validateTaskNameBeforeSubmit(nameInput)) {
        this.highlightWarning(warningMessage)
        validationControls.runValidation()
        return
      }

      const created = await this.createNewTask(taskName, estimatedMinutes)
      if (created) {
        closeModal()
      } else {
        this.highlightWarning(warningMessage)
        validationControls.runValidation()
      }
    })

    document.body.appendChild(modal)
    nameInput.focus()
  }

  private async createNewTask(
    taskName: string,
    estimatedMinutes: number,
  ): Promise<boolean> {
    try {
      const dateStr = this.getCurrentDateString()
      const file = await this.taskCreationService.createTaskFile(
        taskName,
        dateStr,
      )
      await this.waitForFrontmatter(file)
      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
      return true
    } catch (error) {
      console.error("Failed to create task:", error)

      let errorMessage = this.tv(
        "notices.taskCreationFailed",
        "Failed to create task",
      )
      const validation = this.getTaskNameValidator().validate(taskName)
      if (
        (error instanceof Error &&
          error.message.includes("Invalid characters")) ||
        !validation.isValid
      ) {
        errorMessage = this.tv(
          "notices.taskCreationInvalidFilename",
          "Failed to create task: filename contains invalid characters",
        )
      }

      new Notice(errorMessage)
      return false
    }
  }

  private setupTaskNameValidation(
    inputElement: HTMLInputElement,
    submitButton: HTMLButtonElement,
    warningElement: HTMLElement,
  ): { runValidation: () => void; dispose: () => void } {
    let validationTimer: number | null = null

    const runValidation = () => {
      const validation = this.getTaskNameValidator().validate(
        inputElement.value,
      )
      this.updateValidationUI(
        inputElement,
        submitButton,
        warningElement,
        validation,
      )
    }

    const handleInput = () => {
      if (validationTimer !== null) {
        window.clearTimeout(validationTimer)
      }
      validationTimer = window.setTimeout(runValidation, 50)
    }

    inputElement.addEventListener("input", handleInput)
    inputElement.addEventListener("change", runValidation)

    runValidation()

    return {
      runValidation,
      dispose: () => {
        if (validationTimer !== null) {
          window.clearTimeout(validationTimer)
        }
        inputElement.removeEventListener("input", handleInput)
        inputElement.removeEventListener("change", runValidation)
      },
    }
  }

  private updateValidationUI(
    input: HTMLInputElement,
    button: HTMLButtonElement,
    warning: HTMLElement,
    validation: ReturnType<TaskNameValidator["validate"]>,
  ): void {
    if (validation.isValid) {
      input.classList.remove("error")
      button.disabled = false
      button.classList.remove("disabled")
      warning.classList.add("hidden")
      warning.textContent = ""
    } else {
      input.classList.add("error")
      button.disabled = true
      button.classList.add("disabled")
      warning.classList.remove("hidden")
      warning.textContent = this.TaskNameValidator.getErrorMessage(
        validation.invalidChars,
      )
    }
  }

  private highlightWarning(warningElement: HTMLElement): void {
    warningElement.classList.add("highlight")
    window.setTimeout(() => warningElement.classList.remove("highlight"), 300)
  }

  private validateTaskNameBeforeSubmit(nameInput: HTMLInputElement): boolean {
    const validation = this.getTaskNameValidator().validate(nameInput.value)
    return validation.isValid
  }

  private async waitForFrontmatter(
    file: TFile,
    timeoutMs = 4000,
  ): Promise<void> {
    const start = Date.now()
    const hasFrontmatter = () => {
      const cache = this.app.metadataCache.getFileCache(file)
      return Boolean(cache?.frontmatter)
    }

    if (hasFrontmatter()) {
      return
    }

    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      if (hasFrontmatter()) {
        return
      }
    }
  }

  private parseTaskLog(content: string): TaskLogSnapshot {
    try {
      const parsed = JSON.parse(content) as Partial<TaskLogSnapshot>
      const executionsEntries = Object.entries(parsed.taskExecutions ?? {})
      const taskExecutions = executionsEntries.reduce<
        Record<string, TaskLogEntry[]>
      >((acc, [dateKey, value]) => {
        if (Array.isArray(value)) {
          acc[dateKey] = value.filter(
            (entry): entry is TaskLogEntry =>
              Boolean(entry) && typeof entry === "object",
          )
        }
        return acc
      }, {})

      return {
        taskExecutions,
        dailySummary: parsed.dailySummary ?? {},
      }
    } catch (error) {
      console.warn("[TaskChuteView] Failed to parse task log snapshot", error)
      return { taskExecutions: {}, dailySummary: {} }
    }
  }

  private isExecutionCompleted(entry: TaskLogEntry): boolean {
    if (typeof entry.isCompleted === "boolean") return entry.isCompleted
    if (
      entry.stopTime &&
      typeof entry.stopTime === "string" &&
      entry.stopTime.trim().length > 0
    )
      return true
    if (typeof entry.durationSec === "number" && entry.durationSec > 0)
      return true
    if (typeof entry.duration === "number" && entry.duration > 0) return true
    return true
  }

  private persistSlotAssignment(inst: TaskInstance): void {
    const dayState = this.getCurrentDayState()
    const taskPath = inst.task?.path
    const isRoutine = inst.task?.isRoutine === true

    if (taskPath) {
      if (isRoutine) {
        if (!dayState.slotOverrides) {
          dayState.slotOverrides = {}
        }
        const resolvedSlot = inst.slotKey || "none"
        const defaultSlot = inst.task?.scheduledTime
          ? getSlotFromTime(inst.task.scheduledTime)
          : "none"
        if (resolvedSlot === defaultSlot) {
          delete dayState.slotOverrides[taskPath]
        } else {
          dayState.slotOverrides[taskPath] = resolvedSlot
        }
      } else {
        if (!this.plugin.settings.slotKeys) {
          this.plugin.settings.slotKeys = {}
        }
        this.plugin.settings.slotKeys[taskPath] = inst.slotKey || "none"
        void this.plugin.saveSettings()
      }
    }

    if (inst.instanceId) {
      const key = this.getOrderKey(inst)
      if (key && dayState.orders && dayState.orders[key] != null) {
        // keep existing order; noop
      }
      // Persist duplicated metadata slot for today
      if (Array.isArray(dayState.duplicatedInstances)) {
        const dup = dayState.duplicatedInstances.find(
          (d) => d.instanceId === inst.instanceId,
        )
        if (dup) {
          dup.slotKey = inst.slotKey
        }
      }
    }
  }

  private async showTaskMoveDatePicker(
    inst: TaskInstance,
    button: HTMLElement,
  ): Promise<void> {
    if (this.activeMoveCalendar) {
      this.activeMoveCalendar.close()
      this.activeMoveCalendar = null
    }

    const initialDate = (() => {
      const current = this.currentDate
      const targetDate = inst.task?.frontmatter?.target_date
      if (typeof targetDate === "string") {
        const match = targetDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (match) {
          const [, y, m, d] = match
          const parsed = Date.parse(`${y}-${m}-${d}T00:00:00`)
          if (!Number.isNaN(parsed)) {
            return new Date(parsed)
          }
        }
      }
      return new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate(),
      )
    })()

    const calendar = new TaskMoveCalendar({
      anchor: button,
      initialDate,
      today: new Date(),
      onSelect: async (isoDate) => {
        await this.moveTaskToDate(inst, isoDate)
      },
      onClear: async () => {
        await this.clearTaskTargetDate(inst)
      },
      onClose: () => {
        if (this.activeMoveCalendar === calendar) {
          this.activeMoveCalendar = null
        }
      },
    })

    this.activeMoveCalendar = calendar
    calendar.open()
  }

  private activeMoveCalendar: TaskMoveCalendar | null = null

  private async clearTaskTargetDate(inst: TaskInstance): Promise<void> {
    const displayTitle = this.getInstanceDisplayTitle(inst)
    const file = inst.task?.path
      ? this.app.vault.getAbstractFileByPath(inst.task.path)
      : null
    if (!(file instanceof TFile)) {
      return
    }

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (frontmatter.target_date) {
          delete frontmatter.target_date
        }
        return frontmatter
      })
      new Notice(
        this.tv('notices.taskMoveCleared', 'Cleared destination for "{title}"', {
          title: displayTitle,
        }),
      )
      await this.reloadTasksAndRestore()
    } catch (error) {
      console.error("Failed to clear task target date:", error)
      new Notice(
        this.tv(
          "notices.taskMoveClearFailed",
          "Failed to clear task destination",
        ),
      )
    }
  }

  private async moveTaskToDate(
    inst: TaskInstance,
    dateStr: string,
  ): Promise<void> {
    try {
      // タスクを指定日付に移動
      const file = this.app.vault.getAbstractFileByPath(inst.task.path)
      if (file instanceof TFile) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter.target_date = dateStr
          return frontmatter
        })
      }

      new Notice(
        this.tv('notices.taskMoveSuccess', 'Moved task to {date}', {
          date: dateStr,
        }),
      )
      await this.reloadTasksAndRestore()
    } catch (error) {
      console.error("Failed to move task:", error)
      new Notice(this.tv("notices.taskMoveFailed", "Failed to move task"))
    }
  }

  private async showProjectModal(inst: TaskInstance): Promise<void> {
    // showProjectModal calls showUnifiedProjectModal internally
    await this.showUnifiedProjectModal(inst)
  }

  private async showUnifiedProjectModal(inst: TaskInstance): Promise<void> {
    try {
      const displayTitle = this.getInstanceDisplayTitle(inst)
      // Create modal overlay
      const modal = document.createElement("div")
      modal.className = "task-modal-overlay"
      const modalContent = modal.createEl("div", { cls: "task-modal-content" })

      // Modal header
      const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
      modalHeader.createEl(
        "h3",
        {
          text: this.tv(
            'project.settingsTitle',
            `Project settings for "${displayTitle}"`,
            { title: displayTitle },
          ),
        },
      )

      // Close button
      const closeButton = modalHeader.createEl("button", {
        cls: "modal-close-button",
        text: "×",
        attr: { title: t("common.close", "Close") },
      })

      // Form
      const form = modalContent.createEl("form", { cls: "task-form" })

      // Get project list
      let projectFiles: TFile[] = []
      try {
        projectFiles = await this.getProjectFiles()
      } catch (error) {
        console.error("Failed to load project list", error)
        new Notice(
          this.tv(
            "notices.projectListFailed",
            "Failed to load project list",
          ),
        )
        modal.remove()
        return
      }

      if (projectFiles.length === 0) {
        // No project files found
        const noProjectGroup = form.createEl("div", { cls: "form-group" })
        noProjectGroup.createEl("p", {
          text: this.tv('project.noFiles', 'No project files found.'),
          cls: "form-description",
        })
        noProjectGroup.createEl("p", {
          text: this.tv('project.addTagHint', 'Add the #project tag to your project files.'),
          cls: "form-description",
        })
      } else {
        // Project selection
        const projectGroup = form.createEl("div", { cls: "form-group" })
        projectGroup.createEl("label", {
          text: this.tv('project.selectLabel', 'Select project:'),
          cls: "form-label",
        })
        const projectSelect = projectGroup.createEl("select", {
          cls: "form-input",
        })

        // Add "Remove project" option if project is already set
        if (inst.task.projectPath) {
          projectSelect.createEl("option", {
            value: "",
            text: this.tv("buttons.removeProject", "➖ Remove project"),
          })
        } else {
          // Add empty option if no project is set
          const emptyOption = projectSelect.createEl("option", {
            value: "",
            text: this.tv('project.none', 'No project'),
          })
          emptyOption.selected = true
        }

        // Add project list
        projectFiles.forEach((project) => {
          const option = projectSelect.createEl("option", {
            value: project.path,
            text: project.basename,
          })
          // Select current project if set
          if (inst.task.projectPath === project.path) {
            option.selected = true
          }
        })

        // Description
        const descGroup = form.createEl("div", { cls: "form-group" })
        if (inst.task.projectPath) {
          descGroup.createEl("p", {
            text: this.tv(
              'project.instructionsLinked',
              'Select another project or choose "Remove project" to clear the assignment.',
            ),
            cls: "form-description",
          })
        } else {
          descGroup.createEl("p", {
            text: this.tv(
              'project.instructionsUnlinked',
              'Assigning a project lets you review related tasks from the project page.',
            ),
            cls: "form-description",
          })
        }

        // Buttons
        const buttonGroup = form.createEl("div", { cls: "form-button-group" })
        const cancelButton = buttonGroup.createEl("button", {
          type: "button",
          cls: "form-button cancel",
          text: t("common.cancel", "Cancel"),
        })
        buttonGroup.createEl("button", {
          type: "submit",
          cls: "form-button create",
          text: this.tv("buttons.save", "Save"),
        })

        // Event listeners
        form.addEventListener("submit", async (e) => {
          e.preventDefault()
          const selectedProject = projectSelect.value
          await this.setProjectForTask(inst.task, selectedProject)
          this.updateProjectDisplay(inst)
          modal.remove()
        })

        cancelButton.addEventListener("click", () => {
          modal.remove()
        })
      }

      closeButton.addEventListener("click", () => {
        modal.remove()
      })

      // Show modal
      document.body.appendChild(modal)
    } catch (error) {
      console.error("Failed to show project modal:", error)
      new Notice(
        this.tv(
          "notices.projectPickerFailed",
          "Failed to open project picker",
        ),
      )
    }
  }

  private async getProjectFiles(): Promise<TFile[]> {
    const files = this.app.vault.getMarkdownFiles()
    const projectFiles: TFile[] = []
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()

    for (const file of files) {
      // Get files that start with "Project - " in the project folder
      if (
        file.path.startsWith(projectFolderPath + "/") &&
        file.basename.startsWith("Project - ")
      ) {
        projectFiles.push(file)
        continue
      }

      // For compatibility, also search for files starting with "Project - " in other folders
      if (file.basename.startsWith("Project - ")) {
        projectFiles.push(file)
        continue
      }

      // Also check for #project tag
      const content = await this.app.vault.read(file)
      if (content.includes("#project")) {
        projectFiles.push(file)
      }
    }

    return projectFiles
  }

  private async setProjectForTask(
    task: TaskData,
    projectPath: string,
  ): Promise<void> {
    try {
      if (!task.file || !(task.file instanceof TFile)) {
        new Notice(
          this.tv("notices.taskFileMissing", "Task file not found"),
        )
        return
      }

      // Update metadata
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          if (projectPath) {
            // Persist as wikilink only; do not write project_path
            const projectFile =
              this.app.vault.getAbstractFileByPath(projectPath)
            if (projectFile) {
              frontmatter.project = `[[${projectFile.basename}]]`
              delete frontmatter.project_path
            }
          } else {
            // Clear project fields
            delete frontmatter.project
            delete frontmatter.project_path // legacy cleanup
          }
          return frontmatter
        },
      )

      // Update task object
      if (projectPath) {
        const projectFile = this.app.vault.getAbstractFileByPath(projectPath)
        if (projectFile) {
          task.projectPath = projectPath
          task.projectTitle = projectFile.basename
        }
      } else {
        task.projectPath = null
        task.projectTitle = null
      }

      new Notice(this.tv('project.settingsSaved', 'Project settings saved'))
    } catch (error) {
      console.error("Failed to set project:", error)
      new Notice(
        this.tv("notices.projectSetFailed", "Failed to set project"),
      )
    }
  }

  private updateProjectDisplay(inst: TaskInstance): void {
    // Find the task item
    const taskItem = this.taskList?.querySelector(
      `[data-task-path="${inst.task.path}"]`,
    ) as HTMLElement

    if (taskItem) {
      const projectDisplay = taskItem.querySelector(
        ".taskchute-project-display",
      ) as HTMLElement

      if (projectDisplay) {
        // Clear existing display
        projectDisplay.empty()

        if (inst.task.projectPath && inst.task.projectTitle) {
          // If project is set
          const projectButton = projectDisplay.createEl("span", {
            cls: "taskchute-project-button",
            attr: {
              title: this.tv(
                'project.tooltipAssigned',
                'Project: {title}',
                { title: inst.task.projectTitle },
              ),
            },
          })

          projectButton.createEl("span", {
            cls: "taskchute-project-icon",
            text: "📁",
          })

          projectButton.createEl("span", {
            cls: "taskchute-project-name",
            text: inst.task.projectTitle.replace(/^Project\s*-\s*/, ""),
          })

          projectButton.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.showUnifiedProjectModal(inst)
          })

          const externalLinkIcon = projectDisplay.createEl("span", {
            cls: "taskchute-external-link",
            text: "🔗",
            attr: { title: this.tv('project.openNote', 'Open project note') },
          })

          externalLinkIcon.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.openProjectInSplit(inst.task.projectPath)
          })
        } else {
          // If project is not set
          const projectPlaceholder = projectDisplay.createEl("span", {
            cls: "taskchute-project-placeholder",
            attr: {
              title: this.tv('project.clickToSet', 'Click to set project'),
            },
          })

          projectPlaceholder.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.showProjectModal(inst)
          })
        }
      }
    }
  }

  private async openProjectInSplit(projectPath: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(projectPath)
      if (file instanceof TFile) {
        const leaf = this.app.workspace.getLeaf("split")
        await leaf.openFile(file)
      } else {
        new Notice(
          this.tv(
            'project.fileMissingPath',
            'Project file not found: {path}',
            { path: projectPath },
          ),
        )
      }
    } catch (error) {
      console.error("Failed to open project:", error)
      new Notice(
        this.tv("notices.projectOpenFailed", "Failed to open project file"),
      )
    }
  }

  private async hasExecutionHistory(taskPath: string): Promise<boolean> {
    // 実行履歴の確認
    return false // 仮実装
  }

  private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
    // Handle file rename logic (debug log removed)
  }

  private moveInstanceToSlot(
    fromSlot: string,
    fromIdx: number,
    toSlot: string,
    toIdx: number,
  ): void {
    // Handle moving task instances between slots (debug log removed)
  }

  // State management methods for deletion/hiding
  private getDeletedInstances(dateStr: string): DeletedInstance[] {
    const state = this.dayStateCache.get(dateStr)
    return state ? state.deletedInstances : []
  }

  private saveDeletedInstances(
    dateStr: string,
    instances: DeletedInstance[],
  ): void {
    const state = this.dayStateCache.get(dateStr) || {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    }
    state.deletedInstances = instances.filter((x) => !!x)
    this.dayStateCache.set(dateStr, state)
    void this.persistDayState(dateStr)
  }

  private getHiddenRoutines(dateStr: string): HiddenRoutine[] {
    const state = this.dayStateCache.get(dateStr)
    return state ? (state.hiddenRoutines as HiddenRoutine[]) : []
  }

  private saveHiddenRoutines(dateStr: string, routines: HiddenRoutine[]): void {
    const state = this.dayStateCache.get(dateStr) || {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    }
    state.hiddenRoutines = (routines || []).filter((x) => !!x)
    this.dayStateCache.set(dateStr, state)
    void this.persistDayState(dateStr)
  }

  private isInstanceDeleted(
    instanceId: string,
    taskPath: string,
    dateStr: string,
  ): boolean {
    const deletedInstances = this.getDeletedInstances(dateStr)
    return deletedInstances.some((del) => {
      // Instance-level deletion
      if (instanceId && del.instanceId === instanceId) return true
      if (del.deletionType === "permanent" && del.path === taskPath) return true
      return false
    })
  }

  private isInstanceHidden(
    instanceId: string,
    taskPath: string,
    dateStr: string,
  ): boolean {
    const hiddenRoutines = this.getHiddenRoutines(dateStr)
    return hiddenRoutines.some((hidden) => {
      if (hidden.instanceId && hidden.instanceId === instanceId) return true
      if (hidden.instanceId === null && hidden.path && hidden.path === taskPath)
        return true
      return false
    })
  }
}
