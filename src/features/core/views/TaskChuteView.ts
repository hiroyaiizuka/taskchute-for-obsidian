import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  App,
  EventRef,
  TAbstractFile,
  TFile,
} from "obsidian"
import {
  TaskData,
  TaskInstance,
  NavigationState,
  TaskNameValidator,
  AutocompleteInstance,
  DayState,
  TaskChutePluginLike,
} from "../../../types"
import { TimerService } from "../../../services/TimerService"
import { loadTasksRefactored } from "../helpers"
import { RunningTasksService } from "../../../features/core/services/RunningTasksService"
import { ExecutionLogService } from "../../../features/log/services/ExecutionLogService"
import DayStateStoreService from "../../../services/DayStateStoreService"
import TaskOrderManager from "../../../features/core/services/TaskOrderManager"
import { TaskLoaderService } from "../../../features/core/services/TaskLoaderService"
import type { TaskLoaderHost } from "../../../features/core/services/TaskLoaderService"
import { TaskCreationService } from "../../../features/core/services/TaskCreationService"
import { getCurrentLocale, t } from "../../../i18n"
import TaskReloadCoordinator from "../../../features/core/services/TaskReloadCoordinator"
import type { TaskReloadCoordinatorHost } from "../../../features/core/services/TaskReloadCoordinator"
import TaskExecutionService, {
  CrossDayStartPayload,
  calculateCrossDayDuration,
} from "../../../features/core/services/TaskExecutionService"
import type { RunningTaskRecord } from "../../../features/core/services/RunningTasksService"
import NavigationController from "../../../ui/navigation/NavigationController"
import ProjectController from "../../../ui/project/ProjectController"
import TaskDragController from "../../../ui/tasklist/TaskDragController"
import TaskMutationService from "../../../features/core/services/TaskMutationService"
import type { TaskMutationHost } from "../../../features/core/services/TaskMutationService"
import TaskListRenderer from "../../../ui/tasklist/TaskListRenderer"
import type { TaskListRendererHost } from "../../../ui/tasklist/TaskListRenderer"
import TaskContextMenuController from "../../../ui/tasklist/TaskContextMenuController"
import TaskTimeController from "../../../ui/time/TaskTimeController"
import TaskCreationController from "../../../ui/task/TaskCreationController"
import TaskScheduleController from "../../../ui/task/TaskScheduleController"
import TaskCompletionController from "../../../ui/task/TaskCompletionController"
import TaskSettingsTooltipController from "../../../ui/task/TaskSettingsTooltipController"
import TaskSelectionController from "../../../ui/task/TaskSelectionController"
import TaskKeyboardController from "../../../ui/task/TaskKeyboardController"
import RoutineController from "../../routine/controllers/RoutineController"
import TaskHeaderController from "../../../ui/header/TaskHeaderController"
import { showConfirmModal } from "../../../ui/modals/ConfirmModal"
import TaskViewLayout from "../../../ui/layout/TaskViewLayout"

class NavigationStateManager implements NavigationState {
  selectedSection: "routine" | "review" | "log" | "settings" | null = null
  isOpen: boolean = false
}

export class TaskChuteView
  extends ItemView
  implements TaskLoaderHost, TaskReloadCoordinatorHost, TaskMutationHost
{
  // Core Properties
  public readonly plugin: TaskChutePluginLike
  public tasks: TaskData[] = []
  public taskInstances: TaskInstance[] = []
  public currentInstance: TaskInstance | null = null
  public globalTimerInterval: ReturnType<typeof setInterval> | null = null
  public timerService: TimerService | null = null
  public readonly runningTasksService: RunningTasksService
  public readonly executionLogService: ExecutionLogService
  public readonly taskCreationService: TaskCreationService
  public readonly taskLoader: TaskLoaderService
  public readonly taskReloadCoordinator: TaskReloadCoordinator
  public readonly navigationController: NavigationController
  public readonly projectController: ProjectController
  public readonly taskDragController: TaskDragController
  public readonly taskMutationService: TaskMutationService
  public readonly taskListRenderer: TaskListRenderer
  private readonly taskListRendererHost: TaskListRendererHost
  private readonly taskContextMenuController: TaskContextMenuController
  private readonly taskSelectionController: TaskSelectionController
  private readonly taskKeyboardController: TaskKeyboardController
  public readonly taskTimeController: TaskTimeController
  public readonly taskCreationController: TaskCreationController
  public readonly taskScheduleController: TaskScheduleController
  public readonly taskCompletionController: TaskCompletionController
  public readonly taskSettingsTooltipController: TaskSettingsTooltipController
  public readonly taskHeaderController: TaskHeaderController
  public readonly routineController: RoutineController
  private readonly taskViewLayout: TaskViewLayout
  public readonly taskExecutionService: TaskExecutionService

  // Date Navigation
  public currentDate: Date

  // UI Elements
  private taskListElement?: HTMLElement
  public navigationPanel?: HTMLElement
  public navigationOverlay?: HTMLElement
  public navigationContent?: HTMLElement

  // State Management
  public useOrderBasedSort: boolean
  public readonly navigationState: NavigationStateManager
  public autocompleteInstances: AutocompleteInstance[] = []
  public readonly dayStateCache: Map<string, DayState> = new Map()
  public currentDayState: DayState | null = null
  public currentDayStateKey: string | null = null
  public readonly dayStateManager: DayStateStoreService
  public readonly taskOrderManager: TaskOrderManager
  private managedDisposers: Array<() => void> = []
  private resizeObserver: ResizeObserver | null = null

  // Boundary Check (idle-task-auto-move feature)
  public boundaryCheckTimeout: ReturnType<typeof setTimeout> | null = null

  // Debounce Timer
  public renderDebounceTimer: ReturnType<typeof setTimeout> | null = null

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

  public tv(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(`taskChuteView.${key}`, fallback, vars)
  }

  public getWeekdayNames(): string[] {
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
    this.app = plugin.app as App

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
    this.taskLoader = new TaskLoaderService()
    this.taskReloadCoordinator = new TaskReloadCoordinator(this)
    this.navigationController = new NavigationController(this)
    this.projectController = new ProjectController({
      app: this.app,
      plugin: this.plugin,
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getInstanceDisplayTitle: (inst) => this.getInstanceDisplayTitle(inst),
      renderTaskList: () => this.renderTaskList(),
      getTaskListElement: () => this.getTaskListElement(),
      registerDisposer: (cleanup) => this.registerManagedDisposer(cleanup),
    })
    this.taskDragController = new TaskDragController({
      getTaskInstances: () => this.taskInstances,
      sortByOrder: (instances) => this.sortByOrder(instances),
      getStatePriority: (state) => this.getStatePriority(state),
      normalizeState: (state) => this.normalizeState(state),
      moveTaskToSlot: (inst, slot, index) =>
        this.taskMutationService.moveInstanceToSlot(inst, slot, index),
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
    })
    this.taskListRendererHost = this.createTaskListRendererHost()
    this.taskListRenderer = new TaskListRenderer(this.taskListRendererHost)
    this.taskContextMenuController = new TaskContextMenuController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      app: this.app,
      startInstance: (instance) => this.startInstance(instance),
      stopInstance: (instance) => this.stopInstance(instance),
      resetTaskToIdle: (instance) => this.resetTaskToIdle(instance),
      duplicateInstance: (instance) => this.duplicateInstance(instance),
      deleteRoutineTask: (instance) => this.deleteRoutineTask(instance),
      deleteNonRoutineTask: (instance) => this.deleteNonRoutineTask(instance),
      hasExecutionHistory: (path) => this.hasExecutionHistory(path),
    })
    this.taskSelectionController = new TaskSelectionController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getContainer: () => this.containerEl,
      duplicateInstance: (instance) => this.duplicateInstance(instance),
      deleteTask: (instance) => this.deleteTask(instance),
      resetTaskToIdle: (instance) => this.resetTaskToIdle(instance),
      showDeleteConfirmDialog: (instance) =>
        this.showDeleteConfirmDialog(instance),
      notify: (message) => new Notice(message),
    })
    this.taskKeyboardController = new TaskKeyboardController({
      registerManagedDomEvent: (target, event, handler) =>
        this.registerManagedDomEvent(
          target as Document | HTMLElement,
          event as keyof DocumentEventMap | keyof HTMLElementEventMap,
          handler as EventListener,
        ),
      getContainer: () => this.containerEl,
      selectionController: this.taskSelectionController,
    })
    this.taskMutationService = new TaskMutationService(this)
    this.taskTimeController = new TaskTimeController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      app: this.app,
      renderTaskList: () => this.renderTaskList(),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      getInstanceDisplayTitle: (inst) => this.getInstanceDisplayTitle(inst),
      persistSlotAssignment: (inst) => this.persistSlotAssignment(inst),
      executionLogService: this.executionLogService,
      calculateCrossDayDuration: (start, stop) =>
        this.calculateCrossDayDuration(start, stop),
      saveRunningTasksState: () => this.saveRunningTasksState(),
      removeTaskLogForInstanceOnCurrentDate: (instanceId) =>
        this.removeTaskLogForInstanceOnCurrentDate(instanceId),
      getCurrentDate: () => new Date(this.currentDate),
    })
    this.taskCreationController = new TaskCreationController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getTaskNameValidator: () => this.getTaskNameValidator(),
      taskCreationService: this.taskCreationService,
      registerAutocompleteCleanup: (cleanup) =>
        this.registerAutocompleteCleanup(cleanup),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      getCurrentDateString: () => this.getCurrentDateString(),
      app: this.app,
      plugin: this.plugin,
    })
    this.taskScheduleController = new TaskScheduleController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getInstanceDisplayTitle: (inst) => this.getInstanceDisplayTitle(inst),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      app: this.app,
      getCurrentDate: () => new Date(this.currentDate),
      registerDisposer: (cleanup) => this.registerManagedDisposer(cleanup),
    })
    this.taskCompletionController = new TaskCompletionController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      renderTaskList: () => this.renderTaskList(),
      getInstanceDisplayTitle: (inst) => this.getInstanceDisplayTitle(inst),
      calculateCrossDayDuration: (start, stop) =>
        this.calculateCrossDayDuration(start, stop),
      getCurrentDate: () => new Date(this.currentDate),
      app: this.app,
      plugin: this.plugin,
    })
    this.taskSettingsTooltipController = new TaskSettingsTooltipController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      resetTaskToIdle: (inst) => this.resetTaskToIdle(inst),
      showScheduledTimeEditModal: (inst) =>
        this.showScheduledTimeEditModal(inst),
      showTaskMoveDatePicker: (inst, anchor) =>
        this.taskScheduleController.showTaskMoveDatePicker(inst, anchor),
      duplicateInstance: (inst) => this.duplicateInstance(inst, true),
      deleteRoutineTask: (inst) => this.deleteRoutineTask(inst),
      deleteNonRoutineTask: (inst) => this.deleteNonRoutineTask(inst),
      hasExecutionHistory: (path) => this.hasExecutionHistory(path),
      showDeleteConfirmDialog: (inst) => this.showDeleteConfirmDialog(inst),
    })
    this.taskHeaderController = new TaskHeaderController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getCurrentDate: () => new Date(this.currentDate),
      setCurrentDate: (date) => {
        this.currentDate = new Date(
          date.getFullYear(),
          date.getMonth(),
          date.getDate(),
        )
      },
      adjustCurrentDate: (days) => this.adjustCurrentDate(days),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      showAddTaskModal: () => {
        void this.taskCreationController.showAddTaskModal()
      },
      plugin: this.plugin,
      app: this.app,
      registerManagedDomEvent: (target, event, handler) =>
        this.registerManagedDomEvent(target, event, handler),
      toggleNavigation: () => this.navigationController.toggleNavigation(),
      registerDisposer: (cleanup) => this.registerManagedDisposer(cleanup),
    })
    this.routineController = new RoutineController({
      app: this.app,
      plugin: this.plugin,
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getWeekdayNames: () => this.getWeekdayNames(),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      getCurrentDate: () => new Date(this.currentDate),
    })
    this.taskExecutionService = new TaskExecutionService(this)
    this.taskViewLayout = new TaskViewLayout({
      renderHeader: (container) => this.taskHeaderController.render(container),
      createNavigation: (contentContainer) =>
        this.navigationController.createNavigationUI(contentContainer),
      registerTaskListElement: (element) => {
        this.taskListElement = element
      },
    })
    this.dayStateManager = new DayStateStoreService({
      dayStateService: this.plugin.dayStateService,
      cache: this.dayStateCache,
      getCurrentDateString: () => this.getCurrentDateString(),
      parseDateString: (key: string) => this.parseDateString(key),
    })
    this.taskOrderManager = new TaskOrderManager({
      dayStateManager: this.dayStateManager,
      getCurrentDateString: () => this.getCurrentDateString(),
      ensureDayStateForCurrentDate: () => this.ensureDayStateForCurrentDate(),
      getCurrentDayState: () => this.getCurrentDayState(),
      persistDayState: (dateKey: string) => this.persistDayState(dateKey),
      getTimeSlotKeys: () => this.getTimeSlotKeys(),
      getOrderKey: (inst) => this.getOrderKey(inst),
      useOrderBasedSort: () => this.useOrderBasedSort,
      normalizeState: (state) => this.normalizeState(state),
      getStatePriority: (state) => this.getStatePriority(state),
      handleOrderSaveError: (error) => {
        console.error("[TaskChuteView] Failed to save task orders", error)
        new Notice(
          this.tv("notices.taskOrderSaveFailed", "Failed to save task order"),
        )
      },
    })
  }

  private createTaskListRendererHost(): TaskListRendererHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const view = this
    return {
      get taskList() {
        return view.getTaskListElement()
      },
      get taskInstances() {
        return view.taskInstances
      },
      get currentDate() {
        return view.currentDate
      },
      tv: (key, fallback, vars) => view.tv(key, fallback, vars),
      app: view.app,
      applyResponsiveClasses: () => view.applyResponsiveClasses(),
      sortTaskInstancesByTimeOrder: () => view.sortTaskInstancesByTimeOrder(),
      getTimeSlotKeys: () => view.getTimeSlotKeys(),
      sortByOrder: (instances) => view.sortByOrder(instances),
      selectTaskForKeyboard: (inst, element) =>
        view.taskSelectionController.select(inst, element),
      registerManagedDomEvent: (target, event, handler) =>
        view.registerManagedDomEvent(target, event, handler),
      handleDragOver: (event, taskItem, inst) =>
        view.handleDragOver(event, taskItem, inst),
      handleDrop: (event, taskItem, inst) =>
        view.handleDrop(event, taskItem, inst),
      handleSlotDrop: (event, slot) => view.handleSlotDrop(event, slot),
      startInstance: (inst) => view.startInstance(inst),
      stopInstance: (inst) => view.stopInstance(inst),
      duplicateAndStartInstance: (inst) => view.duplicateAndStartInstance(inst),
      showTaskCompletionModal: (inst) =>
        view.taskCompletionController.showTaskCompletionModal(inst),
      hasCommentData: (inst) =>
        view.taskCompletionController.hasCommentData(inst),
      showRoutineEditModal: (task, element) =>
        view.showRoutineEditModal(task, element),
      toggleRoutine: (task, element) => view.toggleRoutine(task, element),
      showTaskSettingsTooltip: (inst, element) =>
        view.taskSettingsTooltipController.show(inst, element),
      showTaskContextMenu: (event, inst) =>
        view.showTaskContextMenu(event, inst),
      calculateCrossDayDuration: (start, stop) =>
        view.calculateCrossDayDuration(start, stop),
      showTimeEditModal: (inst) => view.showTimeEditModal(inst),
      updateTotalTasksCount: () => view.updateTotalTasksCount(),
      showProjectModal: (inst) => view.projectController.showProjectModal(inst),
      showUnifiedProjectModal: (inst) =>
        view.projectController.showUnifiedProjectModal(inst),
      openProjectInSplit: (projectPath) =>
        view.projectController.openProjectInSplit(projectPath),
    }
  }

  private getTaskListElement(): HTMLElement {
    if (!this.taskListElement) {
      throw new Error("Task list element not initialised")
    }
    return this.taskListElement
  }

  public get taskList(): HTMLElement {
    return this.getTaskListElement()
  }

  public set taskList(element: HTMLElement) {
    this.taskListElement = element
  }

  public getViewDate(): Date {
    return new Date(this.currentDate)
  }

  public getCurrentInstance(): TaskInstance | null {
    return this.currentInstance
  }

  public setCurrentInstance(inst: TaskInstance | null): void {
    this.currentInstance = inst
  }

  public restartTimerService(): void {
    this.timerService?.restart()
  }

  public stopTimers(): void {
    this.timerService?.stop()
  }

  public hasRunningInstances(): boolean {
    return this.taskInstances.some((inst) => inst.state === "running")
  }

  public getInstanceDisplayTitle(inst: TaskInstance): string {
    const candidates = [
      inst.task.displayTitle,
      inst.executedTitle,
      inst.task.name,
    ]
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
    const container = this.getContentContainer()
    container.empty()

    await this.setupUI(container)
    await this.reloadTasksAndRestore({ runBoundaryCheck: true })

    // Styles are now provided via styles.css (no dynamic CSS injection)
    // Initialize timer service (ticks update timer displays)
    this.ensureTimerService()
    this.setupResizeObserver()
    this.navigationController.initializeNavigationEventListeners()
    this.setupEventListeners()
  }

  private getContentContainer(): HTMLElement {
    const content = this.containerEl.children.item(1)
    if (!(content instanceof HTMLElement)) {
      throw new Error("[TaskChuteView] content container not initialised")
    }
    return content
  }

  async onClose(): Promise<void> {
    this.disposeManagedEvents()
    // Clean up autocomplete instances
    this.cleanupAutocompleteInstances()

    // Clean up timers
    this.cleanupTimers()
  }

  // ===========================================
  // UI Setup Methods
  // ===========================================

  private async setupUI(container: HTMLElement): Promise<void> {
    const { taskListElement } = this.taskViewLayout.render(container)
    this.taskListElement = taskListElement
  }

  // Utility: reload tasks and immediately restore running-state from persistence
  public async reloadTasksAndRestore(
    options: { runBoundaryCheck?: boolean } = {},
  ): Promise<void> {
    await this.taskReloadCoordinator.reloadTasksAndRestore(options)
  }

  // ===========================================
  // Date Management Methods
  // ===========================================

  public getCurrentDateString(): string {
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
    const state = await this.dayStateManager.ensure(dateStr)
    if (dateStr === this.getCurrentDateString()) {
      this.currentDayState = state
      this.currentDayStateKey = dateStr
    }
    return state
  }

  async getDayState(dateStr: string): Promise<DayState> {
    return this.ensureDayStateForDate(dateStr)
  }

  getDayStateSnapshot(dateStr: string): DayState | null {
    return this.dayStateManager.snapshot(dateStr)
  }

  public async ensureDayStateForCurrentDate(): Promise<DayState> {
    const state = await this.dayStateManager.ensure()
    this.currentDayState = state
    this.currentDayStateKey = this.dayStateManager.getCurrentKey()
    return state
  }

  public getCurrentDayState(): DayState {
    const state = this.dayStateManager.getCurrent()
    this.currentDayState = state
    this.currentDayStateKey = this.dayStateManager.getCurrentKey()
    return state
  }

  public async persistDayState(dateStr: string): Promise<void> {
    await this.dayStateManager.persist(dateStr)
  }

  public getOrderKey(inst: TaskInstance): string | null {
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

  public normalizeState(
    state: TaskInstance["state"],
  ): "done" | "running" | "idle" {
    if (state === "done") return "done"
    if (state === "running" || state === "paused") return "running"
    return "idle"
  }

  public getStatePriority(state: TaskInstance["state"]): number {
    const normalized = this.normalizeState(state)
    if (normalized === "done") return 0
    if (normalized === "running") return 1
    return 2
  }

  // ===========================================
  // Task Loading and Rendering Methods
  // ===========================================

  async loadTasks(): Promise<void> {
    // Use the refactored implementation
    await this.ensureDayStateForCurrentDate()
    await loadTasksRefactored.call(this)
  }

  public generateInstanceId(task: TaskData, dateStr: string): string {
    // Generate a unique ID for this task instance
    return `${task.path}_${dateStr}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`
  }

  public updateDateLabel(_element: Element): void {
    this.taskHeaderController.refreshDateLabel()
  }

  // ===========================================
  // Task Rendering Methods
  // ===========================================

  renderTaskList(): void {
    this.taskListRenderer.render()
  }

  // ===========================================
  // Missing Method Placeholders
  // ===========================================

  private async duplicateAndStartInstance(inst: TaskInstance): Promise<void> {
    const newInst = await this.duplicateInstance(inst, true)
    if (!newInst) return
    this.renderTaskList()
    await this.startInstance(newInst)
    this.renderTaskList()
  }

  private async duplicateInstance(
    inst: TaskInstance,
    returnOnly: boolean = false,
  ): Promise<TaskInstance | void> {
    return this.taskMutationService.duplicateInstance(inst, {
      returnInstance: returnOnly,
    })
  }

  public calculateSimpleOrder(
    targetIndex: number,
    sameTasks: TaskInstance[],
  ): number {
    return this.taskOrderManager.calculateSimpleOrder(targetIndex, sameTasks)
  }

  public showRoutineEditModal(task: TaskData, button?: HTMLElement): void {
    this.routineController.showRoutineEditModal(task, button)
  }

  private async toggleRoutine(
    task: TaskData,
    button?: HTMLElement,
  ): Promise<void> {
    await this.routineController.toggleRoutine(task, button)
  }

  // ===========================================
  // Task State Management Methods
  // ===========================================

  async startInstance(inst: TaskInstance): Promise<void> {
    await this.taskExecutionService.startInstance(inst)
  }

  async stopInstance(inst: TaskInstance): Promise<void> {
    await this.taskExecutionService.stopInstance(inst)
    this.timerService?.restart()
  }

  public async handleCrossDayStart(payload: CrossDayStartPayload): Promise<void> {
    const { today, todayKey, instance } = payload
    await this.persistCrossDayRunningTasks(todayKey, instance)
    const next = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    )
    this.currentDate = next
    await this.reloadTasksAndRestore({ runBoundaryCheck: true })
    this.taskHeaderController.refreshDateLabel()
  }

  public calculateCrossDayDuration(startTime?: Date, stopTime?: Date): number {
    return calculateCrossDayDuration(startTime, stopTime)
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
      const dateKey = this.getCurrentDateString()
      const deletedInstances = this.dayStateManager.getDeleted(dateKey)
      const hiddenRoutines = this.dayStateManager.getHidden(dateKey)
      const deletedPaths = deletedInstances
        .filter((inst) => inst.deletionType === "permanent")
        .map((inst) => inst.path)
        .filter((path): path is string => typeof path === "string")

      const restoredInstances = await this.runningTasksService.restoreForDate({
        dateString: dateKey,
        instances: this.taskInstances,
        deletedPaths,
        hiddenRoutines,
        deletedInstances,
        findTaskByPath: (path) => this.tasks.find((task) => task.path === path),
        generateInstanceId: (task) => this.generateInstanceId(task, dateKey),
      })

      const lastRestored =
        restoredInstances.length > 0
          ? restoredInstances[restoredInstances.length - 1]
          : undefined
      const activeInstance =
        lastRestored ??
        this.taskInstances.find((inst) => inst.state === "running") ??
        null

      this.setCurrentInstance(activeInstance)

      if (activeInstance) {
        this.startGlobalTimer()
        this.renderTaskList()
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

  private createRunningInstanceFromRecord(record: RunningTaskRecord): TaskInstance {
    const task: TaskData = {
      file: null,
      frontmatter: {},
      path: record.taskPath,
      name: record.taskTitle,
      displayTitle: record.taskTitle,
      isRoutine: record.isRoutine === true,
    }
    if (record.taskDescription) {
      ;(task as TaskData & { description?: string }).description =
        record.taskDescription
    }
    const instanceId =
      record.instanceId ??
      this.generateInstanceId(task, record.date ?? this.getCurrentDateString())
    return {
      task,
      instanceId,
      state: "running",
      slotKey: record.slotKey ?? "none",
      originalSlotKey: record.originalSlotKey,
      startTime: record.startTime ? new Date(record.startTime) : undefined,
      date: record.date,
    }
  }

  private async persistCrossDayRunningTasks(
    todayKey: string,
    instance: TaskInstance,
  ): Promise<void> {
    try {
      const existing = await this.runningTasksService.loadForDate(todayKey)
      const preserved = existing
        .filter((record) => record.instanceId !== instance.instanceId)
        .map((record) => this.createRunningInstanceFromRecord(record))

      const instanceForSave: TaskInstance = {
        ...instance,
        state: "running",
        startTime: instance.startTime ?? new Date(),
        slotKey: instance.slotKey ?? "none",
        originalSlotKey: instance.originalSlotKey,
        date: todayKey,
      }

      await this.runningTasksService.save([...preserved, instanceForSave])
    } catch (error) {
      console.error(
        "[TaskChuteView] Failed to persist cross-day running task",
        error,
      )
    }
  }

  // ===========================================
  // Timer Management Methods
  // ===========================================

  public startGlobalTimer(): void {
    this.ensureTimerService()
    this.timerService?.start()
  }

  // ===========================================
  // Time Edit Modal (開始/終了時刻の編集)
  // ===========================================

  private async showScheduledTimeEditModal(inst: TaskInstance): Promise<void> {
    await this.taskTimeController.showScheduledTimeEditModal(inst)
  }

  private showTimeEditModal(inst: TaskInstance): void {
    this.taskTimeController.showTimeEditModal(inst)
  }

  private stopGlobalTimer(): void {}

  // ===========================================
  // Event Handler Methods
  // ===========================================

  private setupEventListeners(): void {
    this.taskKeyboardController.initialize()

    // File rename event listener
    const renameRef = this.app.vault.on("rename", async (file, oldPath) => {
      await this.handleFileRename(file, oldPath)
    })
    this.registerManagedEvent(renameRef)
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
    const container = this.getTaskListElement()
    const timerEl = container.querySelector(selector)
    if (timerEl instanceof HTMLElement) {
      this.taskListRenderer.updateTimerDisplay(timerEl, inst)
    }
  }

  // ===========================================
  // Command Methods (for external commands)
  // ===========================================

  async duplicateSelectedTask(): Promise<void> {
    await this.taskSelectionController.duplicateSelectedTask()
  }

  deleteSelectedTask(): void {
    void this.taskSelectionController.deleteSelectedTask()
  }

  async resetSelectedTask(): Promise<void> {
    await this.taskSelectionController.resetSelectedTask()
  }

  private adjustCurrentDate(days: number): void {
    this.currentDate.setDate(this.currentDate.getDate() + days)
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
    this.taskHeaderController.refreshDateLabel()

    // タスクリストを再読み込みし、実行中タスクも復元
    this.reloadTasksAndRestore({ runBoundaryCheck: true }).then(() => {
      new Notice(this.tv("notices.showToday", "Showing today's tasks"))
    })
  }

  reorganizeIdleTasks(): void {
    this.moveIdleTasksToCurrentTime()
    new Notice(this.tv("notices.idleReorganized", "Reorganized idle tasks"))
  }

  // ===========================================
  // Utility Methods
  // ===========================================

  public getTimeSlotKeys(): string[] {
    return ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
  }

  public sortTaskInstancesByTimeOrder(): void {
    this.taskOrderManager.sortTaskInstancesByTimeOrder(this.taskInstances)
  }

  public async saveTaskOrders(): Promise<void> {
    await this.taskOrderManager.saveTaskOrders(this.taskInstances)
  }

  public registerManagedDomEvent(
    target: Document | HTMLElement,
    event: string,
    handler: EventListener,
  ): void {
    if (typeof this.registerDomEvent === "function") {
      if (target instanceof Document) {
        this.registerDomEvent(target, event as keyof DocumentEventMap, handler)
      } else {
        this.registerDomEvent(
          target,
          event as keyof HTMLElementEventMap,
          handler,
        )
      }
    } else {
      target.addEventListener(event, handler)
    }
    this.registerManagedDisposer(() => {
      target.removeEventListener(event, handler)
    })
  }

  private registerManagedEvent(ref: EventRef & { detach?: () => void }): void {
    if (typeof this.registerEvent === "function") {
      this.registerEvent(ref)
    }

    if (typeof ref.detach === "function") {
      this.registerManagedDisposer(() => {
        try {
          ref.detach?.()
        } catch (error) {
          console.warn("[TaskChuteView] Failed to detach event", error)
        }
      })
    }
  }

  public registerManagedDisposer(cleanup: () => void): void {
    this.managedDisposers.push(cleanup)
  }

  private disposeManagedEvents(): void {
    if (!this.managedDisposers.length) return
    while (this.managedDisposers.length > 0) {
      const disposer = this.managedDisposers.pop()
      try {
        disposer?.()
      } catch (error) {
        console.warn("[TaskChuteView] Error disposing managed listener", error)
      }
    }
  }

  private sortByOrder(instances: TaskInstance[]): TaskInstance[] {
    return this.taskOrderManager.sortByOrder(instances)
  }

  private applyResponsiveClasses(): void {
    // Apply responsive classes based on pane width
    const width = this.containerEl.clientWidth
    const classList = this.containerEl.classList

    const layoutClasses = [
      "taskchute-very-narrow",
      "taskchute-narrow",
      "taskchute-medium",
      "taskchute-wide",
    ]

    classList.remove(...layoutClasses)
    this.taskListElement?.classList.remove(...layoutClasses)

    let layoutClassesToAdd: string[] = ["taskchute-wide"]
    if (width < 520) {
      layoutClassesToAdd = ["taskchute-narrow", "taskchute-very-narrow"]
    } else if (width < 780) {
      layoutClassesToAdd = ["taskchute-narrow"]
    } else if (width < 980) {
      layoutClassesToAdd = ["taskchute-medium"]
    }

    classList.add(...layoutClassesToAdd)
    this.taskListElement?.classList.add(...layoutClassesToAdd)
  }

  private setupResizeObserver(): void {
    if (this.resizeObserver) return

    const observer = new ResizeObserver(() => {
      this.applyResponsiveClasses()
    })

    observer.observe(this.containerEl)
    this.resizeObserver = observer
    this.registerManagedDisposer(() => {
      observer.disconnect()
      if (this.resizeObserver === observer) {
        this.resizeObserver = null
      }
    })
  }

  private updateTotalTasksCount(): void {
    const total = this.taskInstances.length
    const dateStr = this.getCurrentDateString()
    void this.executionLogService
      .updateDailySummaryTotals(dateStr, total)
      .catch((error) => {
        console.warn("[TaskChuteView] Failed to update total task count", error)
      })
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

  private registerAutocompleteCleanup(cleanup: () => void): void {
    this.autocompleteInstances.push({ cleanup })
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

  private async deleteTask(inst: TaskInstance): Promise<void> {
    await this.taskMutationService.deleteTask(inst)
  }

  private showDeleteConfirmDialog(inst: TaskInstance): Promise<boolean> {
    const displayTitle = this.getInstanceDisplayTitle(inst)
    return showConfirmModal(this.app, {
      title: this.tv("forms.deleteConfirmTitle", "Confirm task deletion"),
      message: this.tv("forms.deleteConfirmBody", 'Delete "{task}"?', {
        task: displayTitle,
      }),
      confirmText: t("common.delete", "Delete"),
      cancelText: t("common.cancel", "Cancel"),
      destructive: true,
    })
  }

  private async deleteNonRoutineTask(inst: TaskInstance): Promise<void> {
    await this.taskMutationService.deleteTask(inst)
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<void> {
    await this.taskMutationService.deleteTask(inst)
  }

  private showTaskContextMenu(event: MouseEvent, inst: TaskInstance): void {
    this.taskContextMenuController.show(event, inst)
  }

  private handleDragOver(
    e: DragEvent,
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    this.taskDragController.handleDragOver(e, taskItem, inst)
  }

  private handleDrop(
    e: DragEvent,
    taskItem: HTMLElement,
    targetInst: TaskInstance,
  ): void {
    this.taskDragController.handleDrop(e, taskItem, targetInst)
  }

  private handleSlotDrop(e: DragEvent, slot: string): void {
    this.taskDragController.handleSlotDrop(e, slot)
  }

  private async deleteInstance(inst: TaskInstance): Promise<void> {
    await this.taskMutationService.deleteInstance(inst)
  }

  private async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    await this.taskTimeController.resetTaskToIdle(inst)
  }

  private moveIdleTasksToCurrentTime(): void {
    new Notice(
      this.tv(
        "status.idleFeatureWip",
        "Idle task reordering is under construction",
      ),
    )
  }

  public persistSlotAssignment(inst: TaskInstance): void {
    this.taskMutationService.persistSlotAssignment(inst)
  }

  private async hasExecutionHistory(taskPath: string): Promise<boolean> {
    try {
      return await this.executionLogService.hasExecutionHistory(taskPath)
    } catch (error) {
      console.warn("[TaskChuteView] hasExecutionHistory failed", error)
      return false
    }
  }

  private async handleFileRename(
    file: TAbstractFile,
    oldPath: string,
  ): Promise<void> {
    if (!(file instanceof TFile)) {
      return
    }
    if (file.extension !== 'md') {
      return
    }

    const oldPathNormalized = typeof oldPath === 'string' ? oldPath.trim() : ''
    const newPathNormalized = typeof file.path === 'string' ? file.path.trim() : ''

    if (!oldPathNormalized || !newPathNormalized || oldPathNormalized === newPathNormalized) {
      return
    }

    try {
      const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}
      const frontmatterTitle = typeof metadata.title === 'string' ? metadata.title.trim() : ''
      const displayTitle = frontmatterTitle.length > 0 ? frontmatterTitle : file.basename

      // Update in-memory task references
      this.tasks.forEach((task) => {
        if (task.path !== oldPathNormalized) return
        task.path = newPathNormalized
        task.file = file
        task.name = file.basename
        task.displayTitle = displayTitle
        task.frontmatter = metadata as Record<string, unknown>
      })

      this.taskInstances.forEach((inst) => {
        if (!inst.task || inst.task.path !== oldPathNormalized) return
        inst.task.path = newPathNormalized
        inst.task.file = file
        inst.task.name = file.basename
        if (!inst.task.displayTitle || inst.state !== 'done') {
          inst.task.displayTitle = displayTitle
        }
      })

      if (this.currentInstance?.task?.path === oldPathNormalized) {
        this.currentInstance.task.path = newPathNormalized
        this.currentInstance.task.file = file
        this.currentInstance.task.name = file.basename
        if (!this.currentInstance.task.displayTitle || this.currentInstance.state !== 'done') {
          this.currentInstance.task.displayTitle = displayTitle
        }
      }

      let settingsChanged = false
      if (this.plugin.settings.slotKeys && this.plugin.settings.slotKeys[oldPathNormalized]) {
        const slot = this.plugin.settings.slotKeys[oldPathNormalized]
        delete this.plugin.settings.slotKeys[oldPathNormalized]
        this.plugin.settings.slotKeys[newPathNormalized] = slot
        settingsChanged = true
      }

      await Promise.allSettled([
        this.executionLogService.renameTaskPath(oldPathNormalized, newPathNormalized),
        this.dayStateManager.renameTaskPath(oldPathNormalized, newPathNormalized),
        this.runningTasksService.renameTaskPath(oldPathNormalized, newPathNormalized, {
          newTitle: displayTitle,
        }),
      ])

      if (settingsChanged) {
        await this.plugin.saveSettings()
      }

      await this.reloadTasksAndRestore({ runBoundaryCheck: true })
    } catch (error) {
      console.error('[TaskChuteView] handleFileRename failed', error)
    }
  }
}
