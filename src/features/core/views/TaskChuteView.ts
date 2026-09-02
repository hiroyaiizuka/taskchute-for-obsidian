import { EventRef, ItemView, Notice, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian'
import {
  TaskData,
  TaskInstance,
  NavigationState,
  TaskNameValidator,
  AutocompleteInstance,
  DayState,
  TaskChutePluginLike,
  DeletedInstance,
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
import { TaskReuseService } from "../../../features/core/services/TaskReuseService"
import { getCurrentLocale, t } from "../../../i18n"
import { TASKCHUTE_NAME } from "../../../constants"
import TaskReloadCoordinator from "../../../features/core/services/TaskReloadCoordinator"
import type {
  DayStateCacheClearMode,
  TaskReloadCoordinatorHost,
} from "../../../features/core/services/TaskReloadCoordinator"
import TaskExecutionService, {
  CrossDayStartPayload,
  calculateCrossDayDuration,
} from "../../../features/core/services/TaskExecutionService"
import type { RunningTaskRecord } from "../../../features/core/services/RunningTasksService"
import NavigationController from "../../../ui/navigation/NavigationController"
import ProjectController from "../../../ui/project/ProjectController"
import { GoogleCalendarService } from "../../calendar/services/GoogleCalendarService"
import { CalendarExportModal } from "../../calendar/ui/CalendarExportModal"
import TaskDragController from "../../../ui/tasklist/TaskDragController"
import TaskMutationService from "../../../features/core/services/TaskMutationService"
import type { DuplicateInstanceOptions, TaskMutationHost } from "../../../features/core/services/TaskMutationService"
import TaskListRenderer from "../../../ui/tasklist/TaskListRenderer"
import type { TaskListRendererHost } from "../../../ui/tasklist/TaskListRenderer"
import type { DragPointer } from "../../../ui/tasklist/TaskListPointerDrag"
import TaskContextMenuController from "../../../ui/tasklist/TaskContextMenuController"
import TaskTimeController from "../../../ui/time/TaskTimeController"
import TaskCreationController, {
  CreatedTaskTarget,
  DeletedTaskRestoreCandidate,
} from "../../../ui/task/TaskCreationController"
import TaskScheduleController from "../../../ui/task/TaskScheduleController"
import TaskCompletionController from "../../../ui/task/TaskCompletionController"
import TaskSettingsTooltipController from "../../../ui/task/TaskSettingsTooltipController"
import TaskSelectionController from "../../../ui/task/TaskSelectionController"
import TaskKeyboardController from "../../../ui/task/TaskKeyboardController"
import AccentContrastController from "../../../ui/tasklist/AccentContrastController"
import RoutineController from "../../routine/controllers/RoutineController"
import TaskHeaderController from "../../../ui/header/TaskHeaderController"
import { showConfirmModal } from "../../../ui/modals/ConfirmModal"
import { showDisambiguateStopTimeDateModal } from "../../../ui/modals/DisambiguateStopTimeDateModal"
import TaskViewLayout from "../../../ui/layout/TaskViewLayout"
import { ReminderSettingsModal } from "../../reminder/modals/ReminderSettingsModal"
import { isDeleted as isDeletedEntry, isLegacyDeletionEntry, getEffectiveDeletedAt } from "../../../services/dayState/conflictResolver"
import { SectionConfigService } from "../../../services/SectionConfigService"
import { normalizeReminderTime } from "../../reminder/services/ReminderFrontmatterService"
import { RecipeService, createRecipeProgressKeyForInstance } from "../../recipe/services/RecipeService"
import { TaskRecipeAssignmentService } from "../../recipe/services/TaskRecipeAssignmentService"
import { RecipeRunPopover } from "../../recipe/ui/RecipeRunPopover"
import { RecipeSelectModal } from "../../recipe/modals/RecipeSelectModal"
import RecipeManagerModal from "../../recipe/modals/RecipeManagerModal"
import { isAiTaskFeatureAvailable } from "../../ai-task/availability"
import { AiRunPaneController } from "../../ai-task/ui/AiRunPaneController"
import { createTerminalViewAdapter } from "../../ai-task/ui/TerminalViewAdapter"
import {
  AiPromptNotFoundError,
  AiRunAlreadyActiveError,
} from "../../ai-task/services/AiTaskManager"
import { AiBinaryNotFoundError } from "../../ai-task/services/BinaryLocator"
import { readAiTaskConfig } from "../../ai-task/services/AiTaskFrontmatterReader"
import { AiTaskEditService } from "../../ai-task/services/AiTaskEditService"
import { AiTaskObsidianLinkCoordinator } from "../../ai-task/services/AiTaskObsidianLinkCoordinator"
import { readObsidianTaskLinkConfig } from "../../ai-task/services/ObsidianTaskLinkConfig"
import { collectAiTaskWorkingDirectoryCandidates } from "../../ai-task/services/AiTaskWorkingDirectoryCandidates"
import { matchesAiTaskBoardView } from "../../ai-task/services/BoardViewFilter"
import type {
  AiTaskStartReservation,
  AiTaskManager,
  PreparedAiRun,
} from "../../ai-task/services/AiTaskManager"
import RoutineService from "../../routine/services/RoutineService"
import { getScheduledTime } from "../../../utils/fieldMigration"
import { extractTaskIdFromFrontmatter } from "../../../services/TaskIdManager"
import type {
  AiRunMode,
  AiRunRecord,
  AiTaskBoardView,
} from "../../ai-task/types"

/**
 * Per-device persistence key of the AI board view (App#saveLocalStorage /
 * App#loadLocalStorage — device-local by design, never synced with the vault).
 */
export const AI_TASK_BOARD_VIEW_STORAGE_KEY = 'taskchute-plus.ai-task-board-view'

const AI_TASK_BOARD_VIEWS: readonly AiTaskBoardView[] = ['human', 'ai', 'mixed']

export interface AmbientAiTaskRunResult {
  satisfiedPaths: string[]
  startedRuns: AmbientAiTaskStartedRun[]
}

/** Authoritative timer state produced by the background Ambient view. */
export interface AmbientAiTaskStartedRun {
  /** Exact manager record to reveal in every already-open AI Runs pane. */
  runId: string
  path: string
  instanceId: string
  /** Epoch milliseconds copied from the TaskExecutionService start transition. */
  startTime: number
  slotKey: string
  originalSlotKey: string | undefined
}

class NavigationStateManager implements NavigationState {
  selectedSection: "routine" | "recipes" | "review" | "log" | "settings" | null = null
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
  /** Non-due linked AI routines available only for event materialization. */
  public linkedAiTaskCandidates: TaskInstance[] = []
  public currentInstance: TaskInstance | null = null
  public globalTimerInterval: ReturnType<Window['setInterval']> | null = null
  public timerService: TimerService | null = null
  public readonly runningTasksService: RunningTasksService
  public readonly executionLogService: ExecutionLogService
  public readonly taskCreationService: TaskCreationService
  public readonly taskReuseService: TaskReuseService
  public readonly taskLoader: TaskLoaderService
  public readonly taskReloadCoordinator: TaskReloadCoordinator
  public readonly navigationController: NavigationController
  public readonly projectController: ProjectController
  public readonly googleCalendarService: GoogleCalendarService
  public readonly taskDragController: TaskDragController
  public readonly taskMutationService: TaskMutationService
  public readonly taskListRenderer: TaskListRenderer
  private readonly taskListRendererHost: TaskListRendererHost
  private readonly taskContextMenuController: TaskContextMenuController
  private readonly taskSelectionController: TaskSelectionController
  private readonly taskKeyboardController: TaskKeyboardController
  private readonly accentContrastController: AccentContrastController
  public readonly taskTimeController: TaskTimeController
  public readonly taskCreationController: TaskCreationController
  public readonly taskScheduleController: TaskScheduleController
  public readonly taskCompletionController: TaskCompletionController
  public readonly taskSettingsTooltipController: TaskSettingsTooltipController
  public readonly taskHeaderController: TaskHeaderController
  public readonly routineController: RoutineController
  private readonly taskViewLayout: TaskViewLayout
  public readonly taskExecutionService: TaskExecutionService
  private readonly aiTaskObsidianLinkCoordinator: AiTaskObsidianLinkCoordinator
  public readonly recipeService: RecipeService
  private readonly recipeRunPopover: RecipeRunPopover
  public sectionConfig: SectionConfigService

  // Date Navigation
  public currentDate: Date

  // UI Elements
  private taskListElement?: HTMLElement
  public navigationPanel?: HTMLElement
  public navigationOverlay?: HTMLElement
  public navigationContent?: HTMLElement

  // AI Task pane (mounted only while plugin.aiTaskManager exists)
  private aiPaneContainer: HTMLElement | null = null
  private aiRunPaneController: AiRunPaneController | null = null
  /** Selected board view (render-only filter); restored in the constructor */
  private aiTaskBoardView: AiTaskBoardView = 'mixed'
  /**
   * Per-instance generation used to invalidate an async AI preflight/start
   * when stop (or a newer start) wins the race before dispatch completes.
   */
  private readonly aiStartGenerations = new WeakMap<TaskInstance, number>()

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

  // Boundary Check (idle-task-auto-move feature)
  public boundaryCheckTimeout: ReturnType<Window['setTimeout']> | null = null
  public boundaryCheckWindow: Window | null = null

  // Debounce Timer
  public renderDebounceTimer: ReturnType<Window['setTimeout']> | null = null

  // Debounce Timer for state file modification detection (cross-device sync)
  private stateFileModifyDebounceTimer: ReturnType<Window['setTimeout']> | null =
    null
  private stateFileModifyDebounceWindow: Window | null = null
  private stateFileModifyPendingMonthKeys: Set<string> = new Set()
  private stateFileModifyRequiresFullReload = false

  // Write barrier: queued external changes during loadTasks barrier
  private pendingExternalMergeMonthKeys: Set<string> = new Set()
  private pendingReloadAfterBarrier = false
  private pendingFullReloadAfterBarrier = false
  private isClosingOrClosed = false

  // Debug helper flag
  // Task Name Validator
  private TaskNameValidator: TaskNameValidator = {
    INVALID_CHARS_PATTERN: new RegExp("[:|/\\#^]", "g"),

    validate(this: TaskNameValidator, taskName: string) {
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
    this.app = plugin.app

    // Restore the per-device board view (invalid/missing values → 'mixed')
    this.aiTaskBoardView = this.loadAiTaskBoardView()

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

    // Section config
    this.sectionConfig = new SectionConfigService(this.plugin.settings.customSections)

    // Services
    this.runningTasksService = new RunningTasksService(this.plugin)
    this.executionLogService = new ExecutionLogService(this.plugin)
    this.taskCreationService = new TaskCreationService(this.plugin)
    this.taskReuseService = new TaskReuseService(this.plugin)
    this.taskLoader = new TaskLoaderService()
    this.taskReloadCoordinator = new TaskReloadCoordinator(this)
    this.recipeService = new RecipeService(this.plugin)
    this.recipeRunPopover = new RecipeRunPopover({
      service: this.recipeService,
      getDateKey: () => this.getCurrentDateString(),
      getProgress: (key, dateKey) => this.dayStateManager.getRecipeProgress(dateKey)[key],
      setProgress: (key, progress, dateKey) => this.dayStateManager.setRecipeProgress(key, progress, dateKey),
      openRecipeEditor: (path) => {
        if (!this.isRecipeFeatureEnabled()) return
        new RecipeManagerModal(this.app, this.plugin, {
          initialRecipePath: path,
          onRecipesChanged: () => this.reloadTasksAndRestore({ runBoundaryCheck: true }),
        }).open()
      },
      onProgressChanged: () => this.renderTaskList(),
    })
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
    this.googleCalendarService = new GoogleCalendarService(this.app)
    this.googleCalendarService.setSectionConfig(this.sectionConfig)
    this.runningTasksService.setSectionConfig(this.sectionConfig)
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
          target,
          event,
          handler,
        ),
      getContainer: () => this.containerEl,
      selectionController: this.taskSelectionController,
    })
    this.accentContrastController = new AccentContrastController({
      getContainer: () => this.containerEl,
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
      stopInstance: (instance, stopTime) => this.stopInstance(instance, stopTime),
      confirmStopNextDay: () => this.confirmStopNextDay(),
      disambiguateStopTimeDate: (sameDayDate, nextDayDate) =>
        this.disambiguateStopTimeDate(sameDayDate, nextDayDate),
      setCurrentInstance: (instance) => this.setCurrentInstance(instance),
      startGlobalTimer: () => this.startGlobalTimer(),
      restartTimerService: () => this.restartTimerService(),
      removeTaskLogForInstanceOnCurrentDate: (instanceId, taskId) =>
        this.removeTaskLogForInstanceOnCurrentDate(instanceId, taskId),
      getCurrentDate: () => new Date(this.currentDate),
      getSectionConfig: () => this.sectionConfig,
      syncDuplicateSlotWithScheduledTime: (inst, params) =>
        this.taskMutationService.syncDuplicateSlotWithScheduledTime(inst, params),
      saveScheduledTime: (inst, scheduledTime) =>
        this.updateTaskScheduledTime(inst, scheduledTime),
      onInstanceResetToIdle: async (inst, { wasRunning }) => {
        // Resetting a running instance bypasses stopInstance, so stop the
        // coupled AI run here to keep play/stop coupling symmetric.
        if (wasRunning) {
          this.maybeStopAiRunForInstance(inst)
          await this.aiTaskObsidianLinkCoordinator.handleSourceStopped(inst)
        }
      },
      onInstanceStopped: async (inst) => {
        this.maybeStopAiRunForInstance(inst)
        await this.aiTaskObsidianLinkCoordinator.handleSourceStopped(inst)
      },
      onInstanceStarted: async (inst) => {
        this.maybeStartAiRunForInstance(inst)
        await this.aiTaskObsidianLinkCoordinator.handleSourceStarted(inst)
      },
    })
    this.taskCreationController = new TaskCreationController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getTaskNameValidator: () => this.getTaskNameValidator(),
      taskCreationService: this.taskCreationService,
      aiTaskEditService: new AiTaskEditService(
        this.app,
        new TaskRecipeAssignmentService({
          app: this.app,
          getRecipeFolderPath: () => this.recipeService.getRecipeFolderPath(),
        }),
      ),
      recipeService: this.recipeService,
      taskReuseService: this.taskReuseService,
      hasInstanceForPathToday: (path) => this.hasInstanceForPathToday(path),
      duplicateInstanceForPath: (path, options) =>
        this.duplicateInstanceForPath(path, options),
      invalidateDayStateCache: (dateKey) => this.invalidateDayStateCache(dateKey),
      registerAutocompleteCleanup: (cleanup) =>
        this.registerAutocompleteCleanup(cleanup),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      getCurrentDateString: () => this.getCurrentDateString(),
      app: this.app,
      plugin: this.plugin,
      getAiTaskDefaultWorkingDirectory: () => {
        const adapter = this.app.vault.adapter as unknown as {
          getBasePath?: () => unknown
        }
        try {
          const basePath = adapter.getBasePath?.()
          return typeof basePath === 'string' ? basePath : ''
        } catch {
          return ''
        }
      },
      getAiTaskWorkingDirectoryCandidates: () =>
        collectAiTaskWorkingDirectoryCandidates(
          this.app,
          this.plugin.pathManager.getTaskFolderPath(),
        ),
      getDocumentContext: () => {
        const doc = this.containerEl?.ownerDocument ?? document
        const defaultView = (doc.defaultView) ?? null
        return {
          doc,
          win: defaultView ?? window,
        }
      },
      findDeletedTaskRestoreCandidate: (taskName) =>
        this.findDeletedTaskRestoreCandidate(taskName),
      restoreDeletedTaskCandidate: (candidate) =>
        this.restoreDeletedTaskCandidate(candidate),
      openGoogleCalendarExportForCreatedTask: (target) =>
        this.openGoogleCalendarExportForCreatedTask(target),
    })
    this.taskScheduleController = new TaskScheduleController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getInstanceDisplayTitle: (inst) => this.getInstanceDisplayTitle(inst),
      reloadTasksAndRestore: (options) => this.reloadTasksAndRestore(options),
      app: this.app,
      getCurrentDate: () => new Date(this.currentDate),
      registerDisposer: (cleanup) => this.registerManagedDisposer(cleanup),
      removeDuplicateInstanceFromCurrentDate: (inst) =>
        this.removeDuplicateInstanceFromCurrentDate(inst),
      isDuplicateInstance: (inst) => this.taskMutationService.isDuplicatedTask(inst),
      moveDuplicateInstanceToDate: (inst, dateStr) =>
        this.moveDuplicateInstanceToDate(inst, dateStr),
      moveNonRoutineSlotOverrideToDate: (inst, dateStr) =>
        this.moveNonRoutineSlotOverrideToDate(inst, dateStr),
      moveRunningTaskToDate: async (inst, dateStr) => {
        return await this.runningTasksService.moveRunningTaskToDateStrict({
          targetDate: dateStr,
          instanceId: inst.instanceId,
          taskId: inst.task?.taskId,
          taskPath: inst.task?.path,
        })
      },
      hideRoutineInstanceForDate: (inst, dateStr) =>
        this.hideRoutineInstanceForDate(inst, dateStr),
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
      appendCommentDelta: (dateKey, entry) =>
        this.executionLogService.appendCommentDelta(dateKey, entry),
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
      showReminderSettingsDialog: (inst) => this.showReminderSettingsDialog(inst),
      showRecipeSelectModal: (inst) => this.showRecipeSelectModal(inst),
      hasRecipeAssigned: (inst) => this.recipeService.hasRecipe(inst.task.recipePath),
      isRecipeFeatureEnabled: () => this.isRecipeFeatureEnabled(),
      openGoogleCalendarExport: (inst) =>
        this.openGoogleCalendarExport(inst),
      isGoogleCalendarEnabled: () =>
        this.plugin.settings.googleCalendar?.enabled === true,
      showProjectModal: (inst) => this.projectController.showProjectModal(inst),
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
      isAiTaskFeatureEnabled: () => this.isAiTaskFeatureEnabled(),
      getAiTaskBoardView: () => this.getAiTaskBoardView(),
      setAiTaskBoardView: (boardView) => this.setAiTaskBoardView(boardView),
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
    this.aiTaskObsidianLinkCoordinator = new AiTaskObsidianLinkCoordinator({
      getTaskInstances: () => [
        ...this.taskInstances,
        ...this.linkedAiTaskCandidates,
      ],
      startLinkedAiTask: (target) => this.startLinkedAiTask(target),
      stopLinkedAiTask: async (target) => {
        this.invalidateAiStartAttempt(target)
        const stopped = await this.taskExecutionService.stopInstance(
          target,
          undefined,
        )
        if (stopped) this.maybeStopAiRunForInstance(target)
        return stopped
      },
    })
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
    // Using this-alias to capture view reference for use in object literal getters below
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- required for object literal getters that need consistent 'this' reference
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
      sortTaskInstancesByTimeOrder: () => view.sortTaskInstancesByTimeOrder(),
      getTimeSlotKeys: () => view.getTimeSlotKeys(),
      sortByOrder: (instances) => view.sortByOrder(instances),
      selectTaskForKeyboard: (inst, element) =>
        view.taskSelectionController.select(inst, element),
      registerManagedDomEvent: (target, event, handler) =>
        view.registerManagedDomEvent(target, event, handler),
      handleDragOver: (event, taskItem, inst) =>
        view.handleDragOver(event, taskItem, inst),
      handleDrop: (event, taskItem, inst, payload) =>
        view.handleDrop(event, taskItem, inst, payload),
      handleSlotDrop: (event, slot, payload) => view.handleSlotDrop(event, slot, payload),
      startInstance: (inst) => view.startInstance(inst),
      stopInstance: (inst) => view.stopInstance(inst),
      duplicateAndStartInstance: (inst) => {
        void view.duplicateAndStartInstance(inst)
      },
      showTaskCompletionModal: (inst) =>
        view.taskCompletionController.showTaskCompletionModal(inst),
      hasCommentData: (inst) =>
        view.taskCompletionController.hasCommentData(inst),
      showRoutineEditModal: (task, element) =>
        view.showRoutineEditModal(task, element),
      toggleRoutine: (task, element) => {
        void view.toggleRoutine(task, element)
      },
      showTaskSettingsTooltip: (inst, element) =>
        view.taskSettingsTooltipController.show(inst, element),
      showTaskContextMenu: (event, inst) =>
        view.showTaskContextMenu(event, inst),
      calculateCrossDayDuration: (start, stop) =>
        view.calculateCrossDayDuration(start, stop),
      showStartTimePopup: (inst, anchor) => view.showStartTimePopup(inst, anchor),
      showStopTimePopup: (inst, anchor) => view.showStopTimePopup(inst, anchor),
      showReminderSettingsModal: (inst) => view.showReminderSettingsModal(inst),
      getRecipeProgressSummary: (inst) => view.getRecipeProgressSummary(inst),
      showRecipeRunPopover: (inst, anchor) => view.showRecipeRunPopover(inst, anchor),
      isRecipeFeatureEnabled: () => view.isRecipeFeatureEnabled(),
      isCollapsibleEnabled: () => view.plugin.settings.collapsibleTimeSlots ?? false,
      updateTotalTasksCount: () => view.updateTotalTasksCount(),
      showProjectModal: (inst) => view.projectController.showProjectModal(inst),
      showUnifiedProjectModal: (inst) =>
        view.projectController.showUnifiedProjectModal(inst),
      openProjectInSplit: (projectPath) =>
        view.projectController.openProjectInSplit(projectPath),
      isAiTaskFeatureEnabled: () => view.isAiTaskFeatureEnabled(),
      editAiTask: (inst) => {
        void view.taskCreationController.showEditAiTaskModal(inst)
      },
      getAiTaskBoardView: () => view.getAiTaskBoardView(),
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
    return TASKCHUTE_NAME
  }

  getIcon(): string {
    return "checkmark"
  }

  // ===========================================
  // Core Lifecycle Methods
  // ===========================================

  async onOpen(): Promise<void> {
    this.isClosingOrClosed = false
    const container = this.getContentContainer()
    container.empty()

    this.setupUI(container)
    await this.reloadTasksAndRestore({
      runBoundaryCheck: true,
      clearDayStateCache: 'all',
    })

    // Styles are now provided via styles.css (no dynamic CSS injection)
    // Initialize timer service (ticks update timer displays)
    this.ensureTimerService()
    this.setupAccentContrast()
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
    this.isClosingOrClosed = true
    this.recipeRunPopover.close()
    this.unmountAiRunPane()
    this.disposeManagedEvents()
    // Clean up autocomplete instances
    this.cleanupAutocompleteInstances()

    // Clean up timers
    this.cleanupTimers()
    await Promise.resolve()
  }

  // ===========================================
  // UI Setup Methods
  // ===========================================

  private setupUI(container: HTMLElement): void {
    const { taskListElement, aiPaneContainer } = this.taskViewLayout.render(container)
    this.taskListElement = taskListElement
    this.aiPaneContainer = aiPaneContainer
    this.mountAiRunPane()
  }

  // ===========================================
  // AI Task Integration
  // ===========================================

  private isAiTaskFeatureEnabled(): boolean {
    return isAiTaskFeatureAvailable(this.plugin)
  }

  /**
   * Effective board view for rendering: while the AI Task feature is
   * disabled (toggle OFF or mobile) the board ALWAYS behaves as 'mixed',
   * regardless of what an earlier session stored.
   */
  public getAiTaskBoardView(): AiTaskBoardView {
    return this.isAiTaskFeatureEnabled() ? this.aiTaskBoardView : 'mixed'
  }

  /** Select a board view, persist it per device, and re-render immediately */
  public setAiTaskBoardView(view: AiTaskBoardView): void {
    this.aiTaskBoardView = view
    // A keyboard selection hidden by the new filter must not stay
    // hotkey-actionable (duplicate/delete/reset would hit an invisible row);
    // a selection that stays visible survives the switch.
    const selected = this.taskSelectionController.getSelectedInstance()
    if (selected && !matchesAiTaskBoardView(selected, this.getAiTaskBoardView())) {
      this.taskSelectionController.clear()
    }
    // Duck-typed: App#saveLocalStorage exists at runtime, but test doubles
    // (and older typings) may lack it.
    const app = this.app as unknown as {
      saveLocalStorage?: (key: string, data: unknown) => void
    }
    if (typeof app.saveLocalStorage === 'function') {
      app.saveLocalStorage(AI_TASK_BOARD_VIEW_STORAGE_KEY, view)
    }
    this.renderTaskList()
  }

  /** Read the stored board view; anything unexpected falls back to 'mixed' */
  private loadAiTaskBoardView(): AiTaskBoardView {
    const app = this.app as unknown as {
      loadLocalStorage?: (key: string) => unknown
    }
    const stored: unknown =
      typeof app.loadLocalStorage === 'function'
        ? app.loadLocalStorage(AI_TASK_BOARD_VIEW_STORAGE_KEY)
        : null
    const match = AI_TASK_BOARD_VIEWS.find((view) => view === stored)
    return match ?? 'mixed'
  }

  private async startAiRun(
    inst: TaskInstance,
    options: { suppressAlreadyActive?: boolean } = {},
  ): Promise<boolean> {
    const manager = this.plugin.aiTaskManager
    if (!manager) return false
    return Boolean(await this.startAiRunWithManager(inst, manager, options))
  }

  private async startAiRunWithManager(
    inst: TaskInstance,
    manager: AiTaskManager,
    options: { suppressAlreadyActive?: boolean } = {},
    prepared?: PreparedAiRun,
    reservation?: AiTaskStartReservation,
  ): Promise<AiRunRecord | null> {
    const file = inst.task.file
    if (!file) {
      this.notifyAiRunError(new Error(inst.task.path))
      return null
    }
    try {
      // Derive the initial PTY grid from the pane before the run starts
      // (120x30 fallback when no pane is mounted or measurable). Subsequent
      // pane resizes update the PTY. instanceId retains the originating task
      // instance for timer/run ownership; mode follows the settings dropdown.
      const size = this.aiRunPaneController?.computeTerminalSize() ?? {
        cols: 120,
        rows: 30,
      }
      const mode: AiRunMode =
        this.plugin.settings.aiTaskRunMode === 'headless' ? 'headless' : 'terminal'
      const record = prepared
        ? await manager.startPreparedRun(prepared, {
            instanceId: inst.instanceId,
            cols: size.cols,
            rows: size.rows,
          }, reservation)
        : await manager.startRun(file, {
            mode,
            instanceId: inst.instanceId,
            cols: size.cols,
            rows: size.rows,
          })
      this.aiRunPaneController?.openRun(record.id)
      this.renderTaskList()
      return record
    } catch (error) {
      if (options.suppressAlreadyActive && error instanceof AiRunAlreadyActiveError) {
        return manager.getActiveRunForTask(inst.task.path) ?? null
      }
      this.notifyAiRunError(error)
      return null
    }
  }

  private async prepareAiRunForInstance(
    inst: TaskInstance,
    manager: AiTaskManager,
  ): Promise<
    | { kind: 'not-needed' }
    | { kind: 'ready'; prepared: PreparedAiRun }
    | { kind: 'failed' }
  > {
    if (!readAiTaskConfig(inst.task.frontmatter)) return { kind: 'not-needed' }
    if (!inst.task.file || !inst.task.path) return { kind: 'not-needed' }
    if (manager.getActiveRunForTask(inst.task.path)) return { kind: 'not-needed' }

    // Older injected test doubles intentionally implement only startRun.
    // Production managers always expose prepareRun; keep the legacy fallback
    // so unrelated host tests do not gain a new mock requirement.
    if (typeof manager.prepareRun !== 'function') return { kind: 'not-needed' }
    try {
      const mode: AiRunMode =
        this.plugin.settings.aiTaskRunMode === 'headless' ? 'headless' : 'terminal'
      const prepared = await manager.prepareRun(inst.task.file, { mode })
      return { kind: 'ready', prepared }
    } catch (error) {
      this.notifyAiRunError(error)
      return { kind: 'failed' }
    }
  }

  private reservePreparedAiRun(
    manager: AiTaskManager,
    prepared: PreparedAiRun,
  ): AiTaskStartReservation | undefined {
    // A few isolated host tests inject the pre-reservation manager contract.
    // The production manager always exposes this method.
    if (typeof manager.reserveTaskStart !== 'function') return undefined
    return manager.reserveTaskStart(prepared.taskPath)
  }

  private releasePreparedAiRunReservation(
    manager: AiTaskManager,
    reservation: AiTaskStartReservation | undefined,
  ): void {
    if (!reservation) return
    manager.releaseTaskStartReservation(reservation)
  }

  /**
   * Resolve the authoritative row after TaskExecutionService may have
   * switched dates and reloaded the task list. restoreForDate preserves the
   * running record's instanceId, so prefer that stable identity; use path
   * only when there is a single unambiguous running generation.
   */
  private resolveCurrentAiStartInstance(
    original: TaskInstance,
    originalWasKnownToView: boolean,
  ): TaskInstance | undefined {
    const candidates = [
      ...this.taskInstances,
      ...this.linkedAiTaskCandidates,
    ].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    )
    const exact = original.instanceId
      ? candidates.find(
          (candidate) => candidate.instanceId === original.instanceId,
        )
      : undefined
    if (exact) return exact.state === 'running' ? exact : undefined

    const samePath = candidates.filter(
      (candidate) =>
        candidate.task?.path.length > 0 &&
        candidate.task.path === original.task?.path,
    )
    if (samePath.length > 0) {
      const running = samePath.filter(
        (candidate) => candidate.state === 'running',
      )
      if (running.length === 1) return running[0]
      const originalStart = original.startTime?.getTime()
      if (originalStart !== undefined) {
        return running.find(
          (candidate) => candidate.startTime?.getTime() === originalStart,
        )
      }
      return undefined
    }

    // Lightweight unit hosts do not mount their instance collection. Only
    // those callers may keep using the original object; a real mounted row
    // disappearing during reload is cancellation, not permission to launch.
    return !originalWasKnownToView && original.state === 'running'
      ? original
      : undefined
  }

  private beginAiStartAttempt(inst: TaskInstance): number {
    const generation = (this.aiStartGenerations.get(inst) ?? 0) + 1
    this.aiStartGenerations.set(inst, generation)
    return generation
  }

  private invalidateAiStartAttempt(inst: TaskInstance): void {
    this.aiStartGenerations.set(
      inst,
      (this.aiStartGenerations.get(inst) ?? 0) + 1,
    )
  }

  private isCurrentAiStartAttempt(
    inst: TaskInstance,
    generation: number,
  ): boolean {
    return this.aiStartGenerations.get(inst) === generation
  }

  /**
   * Play/stop coupling: a successful human start of an ai_task instance also
   * fires the AI run (same path as the row 🤖 button, pane tab included).
   * An already-active run is skipped silently. Prepared-run failures roll the
   * just-started timer back so the UI cannot claim Running without a process;
   * the legacy non-preflight fallback remains additive for injected mocks.
   */
  private maybeStartAiRunForInstance(inst: TaskInstance): void {
    const manager = this.plugin.aiTaskManager
    if (!manager) return
    // Defense in depth: the caller gates on the service's success flag, and
    // a successful start always leaves the instance running.
    if (inst.state !== 'running') return
    if (!readAiTaskConfig(inst.task.frontmatter)) return
    const taskPath = inst.task.path
    if (!taskPath) return
    if (manager.getActiveRunForTask(taskPath)) return
    void this.startAiRun(inst, { suppressAlreadyActive: true })
  }

  private async rollbackAiTimerStart(
    inst: TaskInstance,
    snapshot: {
      state: TaskInstance['state']
      startTime?: Date
      stopTime?: Date
      slotKey?: string
      originalSlotKey?: string
      currentInstance: TaskInstance | null
    },
  ): Promise<void> {
    inst.state = snapshot.state
    inst.startTime = snapshot.startTime
    inst.stopTime = snapshot.stopTime
    inst.slotKey = snapshot.slotKey ?? 'none'
    inst.originalSlotKey = snapshot.originalSlotKey

    if (this.currentInstance === inst) {
      this.currentInstance =
        snapshot.currentInstance?.state === 'running'
          ? snapshot.currentInstance
          : null
    }

    try {
      await this.removeRunningTaskRecord({
        instanceId: inst.instanceId,
        taskPath: inst.task?.path,
        taskId: inst.task?.taskId,
      })
    } catch (error) {
      console.warn(
        '[TaskChuteView] AI timer rollback running-state cleanup failed',
        error,
      )
    }
    try {
      await this.saveRunningTasksState()
    } catch (error) {
      console.warn(
        '[TaskChuteView] AI timer rollback persist failed',
        error,
      )
    }
    this.renderTaskList()
  }

  /**
   * Execute due Ambient AI routines through the same timer/process path as a
   * play-button start. The plugin-owned scheduler passes paths discovered from
   * vault metadata; a dedicated background view reloads today's persisted task
   * state before it decides whether each candidate still needs a launch.
   *
   * Returned satisfied paths are safe for the scheduler to persist for the day
   * (newly launched, already running/completed, or intentionally hidden).
   * Newly launched runs also carry the exact timer snapshot for visible-view
   * mirroring. Transient failures and candidates that became linked/ineligible
   * are omitted so a later tick may retry or re-evaluate them.
   */
  public async runDueAmbientAiTasks(
    candidatePaths: readonly string[],
    now: Date = new Date(),
  ): Promise<AmbientAiTaskRunResult> {
    const emptyResult = (): AmbientAiTaskRunResult => ({
      satisfiedPaths: [],
      startedRuns: [],
    })
    if (this.isClosingOrClosed || !this.plugin.aiTaskManager) {
      return emptyResult()
    }

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayKey = this.formatDateKey(today)
    // Runtime composition always supplies a transient view initialized to
    // today. Refuse a borrowed/user-visible view instead of changing its date.
    if (this.getCurrentDateString() !== todayKey) return emptyResult()
    const uniquePaths = [
      ...new Set(candidatePaths.filter((path) => path.trim().length > 0)),
    ]

    this.currentDayState = null
    this.currentDayStateKey = null
    await this.reloadTasksAndRestore({
      runBoundaryCheck: false,
      clearDayStateCache: 'current',
      queueIfInProgress: true,
    })
    if (this.getCurrentDateString() !== todayKey) return emptyResult()

    const satisfied: string[] = []
    const startedRuns: AmbientAiTaskStartedRun[] = []
    for (const path of uniquePaths) {
      const pathInstances = this.taskInstances.filter(
        (instance) => instance.task?.path === path,
      )

      if (pathInstances.length === 0) {
        // Empty results also occur when vault/day-state loading fails. Only an
        // explicit day-state tombstone is safe to persist as satisfied.
        if (this.isAmbientAiPathSuppressed(path, todayKey)) {
          satisfied.push(path)
        }
        continue
      }

      const representative = pathInstances[0]
      if (!this.isDueAmbientAiInstance(representative, now, todayKey)) {
        continue
      }

      const manager = this.plugin.aiTaskManager
      if (!manager) break

      const alreadySatisfied = pathInstances.some(
        (instance) => instance.state !== 'idle',
      ) || Boolean(manager.getActiveRunForTask(path))
      if (alreadySatisfied) {
        satisfied.push(path)
        continue
      }

      const target = pathInstances.find(
        (instance) =>
          instance.state === 'idle' && instance.isDuplicate !== true,
      )
      if (!target) {
        satisfied.push(path)
        continue
      }

      const startedRun = await this.startAmbientAiInstance(target, manager)
      if (startedRun) {
        satisfied.push(path)
        startedRuns.push(startedRun)
      }
    }
    return { satisfiedPaths: satisfied, startedRuns }
  }

  /** Mirror newly auto-started timers into an already-open visible view. */
  public syncAmbientAiTaskRuns(
    startedRuns: readonly AmbientAiTaskStartedRun[],
    dateKey: string,
  ): void {
    if (
      this.isClosingOrClosed ||
      this.getCurrentDateString() !== dateKey ||
      !this.plugin.aiTaskManager
    ) {
      return
    }

    let changed = false
    const uniqueRuns = new Map<string, AmbientAiTaskStartedRun>()
    for (const run of startedRuns) {
      uniqueRuns.set(`${run.instanceId}\u0000${run.path}`, run)
    }
    for (const run of uniqueRuns.values()) {
      if (!Number.isFinite(run.startTime)) continue
      const matchingInstance = this.taskInstances.find(
        (candidate) => candidate.instanceId === run.instanceId,
      )
      const instance = matchingInstance ?? this.taskInstances.find(
        (candidate) =>
          candidate.task?.path === run.path &&
          candidate.state === 'idle' &&
          candidate.isDuplicate !== true,
      )
      if (!instance || instance.state !== 'idle') continue

      instance.state = 'running'
      instance.startTime = new Date(run.startTime)
      instance.slotKey = run.slotKey
      instance.originalSlotKey = run.originalSlotKey
      this.currentInstance = instance
      changed = true
    }

    // Manager change events create the run view in every mounted pane, but
    // only the background source calls openRun during dispatch. Mirror the
    // manual-start contract here as well: uncollapse the visible AI Runs pane
    // and select the exact newly-started terminal. Calling in start order
    // intentionally leaves the final run selected when one tick starts many.
    for (const run of uniqueRuns.values()) {
      this.aiRunPaneController?.openRun(run.runId)
    }

    if (!changed) return
    this.startGlobalTimer()
    this.restartTimerService()
    this.renderTaskList()
  }

  private isAmbientAiPathSuppressed(path: string, dateKey: string): boolean {
    try {
      if (this.dayStateManager.isHidden({ path, dateKey })) return true

      const file = this.app.vault.getAbstractFileByPath(path)
      const frontmatter =
        file instanceof TFile
          ? this.app.metadataCache.getFileCache(file)?.frontmatter
          : undefined
      const taskId = extractTaskIdFromFrontmatter(frontmatter)
      return this.dayStateManager.isDeleted({
        path,
        dateKey,
        ...(taskId ? { taskId } : {}),
      })
    } catch {
      // A state/cache read failure must retry on the next scheduler tick.
      return false
    }
  }

  private isDueAmbientAiInstance(
    inst: TaskInstance,
    now: Date,
    dateKey: string,
  ): boolean {
    const frontmatter = inst.task?.frontmatter
    if (!frontmatter || readAiTaskConfig(frontmatter) === null) return false
    if (readObsidianTaskLinkConfig(frontmatter) !== null) return false
    if (inst.task.isRoutine !== true && frontmatter['isRoutine'] !== true) {
      return false
    }

    const rule = RoutineService.parseFrontmatter(frontmatter)
    const targetDate =
      typeof frontmatter['target_date'] === 'string' &&
      frontmatter['target_date'] !== frontmatter['routine_start']
        ? frontmatter['target_date']
        : undefined
    if (!RoutineService.isDue(dateKey, rule, targetDate)) return false

    const scheduledTime = normalizeReminderTime(
      getScheduledTime(frontmatter) ?? inst.task.scheduledTime,
    )
    if (!scheduledTime) return false
    const [hours, minutes] = scheduledTime.split(':').map(Number)
    const scheduledAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hours,
      minutes,
      0,
      0,
    )
    return now.getTime() >= scheduledAt.getTime()
  }

  private async startLinkedAiTask(
    target: TaskInstance,
  ): Promise<TaskInstance | null> {
    // The link must never mutate timer state when the AI subsystem is not
    // available. maybeStartAiRunForInstance is intentionally a no-op in that
    // case, so gate before TaskExecutionService changes the target.
    const managerAtDispatch = this.plugin.aiTaskManager
    if (!managerAtDispatch) return null

    const targetGeneration = this.beginAiStartAttempt(target)
    const preflight = await this.prepareAiRunForInstance(
      target,
      managerAtDispatch,
    )
    if (preflight.kind === 'failed') return null

    let reservation: AiTaskStartReservation | undefined
    if (preflight.kind === 'ready') {
      try {
        reservation = this.reservePreparedAiRun(
          managerAtDispatch,
          preflight.prepared,
        )
      } catch (error) {
        this.notifyAiRunError(error)
        return null
      }
    }

    let materializedTarget: TaskInstance | null = null
    const rollbackMaterializedTarget = async (): Promise<void> => {
      if (!materializedTarget) return
      await this.taskMutationService.rollbackDuplicateInstance(
        materializedTarget,
      )
    }

    try {
      if (!this.isCurrentAiStartAttempt(target, targetGeneration)) return null

      let startedTarget = target
      const mustMaterialize =
        target.state === 'done' ||
        this.linkedAiTaskCandidates.includes(target)
      if (mustMaterialize) {
        const duplicate = await this.duplicateInstance(
          target,
          true,
          undefined,
          { suppressNotice: true },
        )
        if (!duplicate) return null
        startedTarget = duplicate
        materializedTarget = duplicate
      }

      if (!this.isCurrentAiStartAttempt(target, targetGeneration)) {
        await rollbackMaterializedTarget()
        return null
      }
      const startedTargetGeneration = startedTarget === target
        ? targetGeneration
        : this.beginAiStartAttempt(startedTarget)
      const startedTargetWasKnownToView =
        this.taskInstances.includes(startedTarget) ||
        this.linkedAiTaskCandidates.includes(startedTarget)

      if (this.plugin.aiTaskManager !== managerAtDispatch) {
        await rollbackMaterializedTarget()
        return null
      }

      const preStartSnapshot = {
        state: startedTarget.state,
        startTime: startedTarget.startTime,
        stopTime: startedTarget.stopTime,
        slotKey: startedTarget.slotKey,
        originalSlotKey: startedTarget.originalSlotKey,
        currentInstance: this.currentInstance,
      }

      let started = false
      try {
        started = await this.taskExecutionService.startInstance(
          startedTarget,
        )
      } catch (error) {
        // TaskExecutionService normally reports failure with false, but an
        // injected/alternate implementation must not leave a materialized
        // linked routine behind either.
        console.error('[TaskChuteView] linked AI task start failed', error)
      }
      if (!started) {
        await rollbackMaterializedTarget()
        return null
      }

      let currentTarget = this.resolveCurrentAiStartInstance(
        startedTarget,
        startedTargetWasKnownToView,
      )
      if (
        this.plugin.aiTaskManager !== managerAtDispatch ||
        !this.isCurrentAiStartAttempt(
          startedTarget,
          startedTargetGeneration,
        ) ||
        !currentTarget
      ) {
        const rollbackTarget =
          currentTarget ??
          (startedTarget.state === 'running' ? startedTarget : undefined)
        if (rollbackTarget?.state === 'running') {
          await this.rollbackAiTimerStart(
            rollbackTarget,
            preStartSnapshot,
          )
        }
        await rollbackMaterializedTarget()
        return null
      }

      if (preflight.kind === 'ready') {
        const record = await this.startAiRunWithManager(
          currentTarget,
          managerAtDispatch,
          {},
          preflight.prepared,
          reservation,
        )
        if (!record) {
          await this.rollbackAiTimerStart(currentTarget, preStartSnapshot)
          await rollbackMaterializedTarget()
          return null
        }

        const currentTargetWasKnownToView =
          this.taskInstances.includes(currentTarget) ||
          this.linkedAiTaskCandidates.includes(currentTarget)
        currentTarget = this.resolveCurrentAiStartInstance(
          currentTarget,
          currentTargetWasKnownToView,
        )
        if (
          this.plugin.aiTaskManager !== managerAtDispatch ||
          !this.isCurrentAiStartAttempt(
            startedTarget,
            startedTargetGeneration,
          ) ||
          !currentTarget
        ) {
          managerAtDispatch.requestStopForTask(startedTarget.task.path)
          const rollbackTarget =
            currentTarget ??
            (startedTarget.state === 'running' ? startedTarget : undefined)
          if (rollbackTarget?.state === 'running') {
            await this.rollbackAiTimerStart(
              rollbackTarget,
              preStartSnapshot,
            )
          }
          await rollbackMaterializedTarget()
          return null
        }
      } else {
        this.maybeStartAiRunForInstance(currentTarget)
      }
      return currentTarget
    } finally {
      this.releasePreparedAiRunReservation(
        managerAtDispatch,
        reservation,
      )
    }
  }

  private async startAmbientAiInstance(
    inst: TaskInstance,
    manager: AiTaskManager,
  ): Promise<AmbientAiTaskStartedRun | null> {
    const startGeneration = this.beginAiStartAttempt(inst)
    const preflight = await this.prepareAiRunForInstance(inst, manager)
    if (preflight.kind === 'failed') return null
    let reservation: AiTaskStartReservation | undefined
    if (preflight.kind === 'ready') {
      try {
        reservation = this.reservePreparedAiRun(manager, preflight.prepared)
      } catch (error) {
        this.notifyAiRunError(error)
        return null
      }
    }
    const originalWasKnownToView =
      this.taskInstances.includes(inst) ||
      this.linkedAiTaskCandidates.includes(inst)

    try {
      if (!this.isCurrentAiStartAttempt(inst, startGeneration)) return null
      const snapshot = {
        state: inst.state,
        startTime: inst.startTime,
        stopTime: inst.stopTime,
        slotKey: inst.slotKey,
        originalSlotKey: inst.originalSlotKey,
        currentInstance: this.currentInstance,
      }
      const started = await this.taskExecutionService.startInstance(inst)
      if (!started) return null

      let startedInstance = this.resolveCurrentAiStartInstance(
        inst,
        originalWasKnownToView,
      )
      if (
        !this.isCurrentAiStartAttempt(inst, startGeneration) ||
        !startedInstance
      ) {
        const rollbackTarget =
          startedInstance ?? (inst.state === 'running' ? inst : undefined)
        if (rollbackTarget?.state === 'running') {
          await this.rollbackAiTimerStart(rollbackTarget, snapshot)
        }
        return null
      }

      if (this.plugin.aiTaskManager !== manager) {
        await this.rollbackAiTimerStart(startedInstance, snapshot)
        return null
      }

      const record = await this.startAiRunWithManager(
        startedInstance,
        manager,
        {},
        preflight.kind === 'ready' ? preflight.prepared : undefined,
        reservation,
      )
      if (!record) {
        await this.rollbackAiTimerStart(startedInstance, snapshot)
        return null
      }

      const startedInstanceWasKnownToView =
        this.taskInstances.includes(startedInstance) ||
        this.linkedAiTaskCandidates.includes(startedInstance)
      startedInstance = this.resolveCurrentAiStartInstance(
        startedInstance,
        startedInstanceWasKnownToView,
      )
      if (
        this.plugin.aiTaskManager !== manager ||
        !this.isCurrentAiStartAttempt(inst, startGeneration) ||
        !startedInstance
      ) {
        manager.requestStopForTask(inst.task.path)
        const rollbackTarget =
          startedInstance ?? (inst.state === 'running' ? inst : undefined)
        if (rollbackTarget?.state === 'running') {
          await this.rollbackAiTimerStart(rollbackTarget, snapshot)
        }
        return null
      }
      const startTime = startedInstance.startTime?.getTime()
      if (startTime === undefined || !Number.isFinite(startTime)) {
        manager.requestStopForTask(inst.task.path)
        await this.rollbackAiTimerStart(startedInstance, snapshot)
        return null
      }
      return {
        runId: record.id,
        path: startedInstance.task.path,
        instanceId: startedInstance.instanceId,
        startTime,
        slotKey: startedInstance.slotKey,
        originalSlotKey: startedInstance.originalSlotKey,
      }
    } finally {
      this.releasePreparedAiRunReservation(manager, reservation)
    }
  }

  private formatDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  /** Play/stop coupling: a human stop also stops the task's active AI run */
  private maybeStopAiRunForInstance(inst: TaskInstance): void {
    const manager = this.plugin.aiTaskManager
    if (!manager) return
    const taskPath = inst.task.path
    if (!taskPath) return
    // Duplicated instances share one task note and therefore one AI run.
    // Keep the run alive while any sibling instance is still running.
    const siblingStillRunning = this.taskInstances.some(
      (other) =>
        other !== inst &&
        other.instanceId !== inst.instanceId &&
        other.task?.path === taskPath &&
        other.state === 'running',
    )
    if (siblingStillRunning) return
    // requestStopForTask also queues the stop when the coupled AI start is
    // still in its async window (before the run record registers), so a
    // stop/reset/delete during that window is never silently lost.
    manager.requestStopForTask(taskPath)
  }

  /**
   * Reverse coupling for the AI Runs × control. Prefer the originating
   * instance id (duplicate-safe), then fall back to the task path for runs
   * restored with a stale/missing id. The pane stops the process itself;
   * this method owns only the normal TaskChute running -> done transition.
   */
  private handleAiRunStopAndClose(record: AiRunRecord): void {
    void this.stopTaskForAiRunClose(record).catch((error: unknown) => {
      console.error('[TaskChuteView] Failed to stop task from AI run close', error)
    })
  }

  private async stopTaskForAiRunClose(record: AiRunRecord): Promise<void> {
    const visibleTarget = this.findRunningInstanceForAiRun(record)
    if (visibleTarget) {
      await this.stopInstance(visibleTarget)
      return
    }

    // AI Runs is global to the TaskChute view, but its originating timer may
    // belong to yesterday (or another manually selected date). Resolve that
    // durable timer instead of stopping only the CLI and leaving TaskChute
    // with no completion entry.
    const persisted = await this.runningTasksService.findByInstanceOrPathStrict({
      instanceId: record.instanceId,
      taskPath: record.taskPath,
    })
    if (!persisted) return
    await this.stopInstance(this.createRunningInstanceFromRecord(persisted))
  }

  private findRunningInstanceForAiRun(record: AiRunRecord): TaskInstance | undefined {
    if (record.host === 'shell') return undefined
    const byInstanceId = record.instanceId
      ? this.taskInstances.find(
          (instance) =>
            instance.instanceId === record.instanceId &&
            instance.state === 'running',
        )
      : undefined
    return (
      byInstanceId ??
      this.taskInstances.find(
        (instance) =>
          instance.state === 'running' &&
          record.taskPath.length > 0 &&
          instance.task?.path === record.taskPath,
      )
    )
  }

  /** One AI process is shared by duplicate instances of the same task note. */
  private findRunningInstancesForAiRunRecovery(record: AiRunRecord): TaskInstance[] {
    if (record.host === 'shell') return []
    const belongsToRestoredGeneration = (instance: TaskInstance): boolean => {
      if (instance.state !== 'running') return false
      const startedAt = instance.startTime?.getTime()
      if (startedAt === undefined || !Number.isFinite(startedAt)) {
        return (
          record.instanceId !== undefined &&
          instance.instanceId === record.instanceId
        )
      }
      // restoreSessionState stamps endedAt when the former live process is
      // normalized to interrupted. A timer started after that cutoff is a new
      // generation and must never be cleared by the settled old repair.
      return record.endedAt === undefined || startedAt <= record.endedAt
    }
    if (record.taskPath.length > 0) {
      return this.taskInstances.filter(
        (instance) =>
          instance.task?.path === record.taskPath &&
          belongsToRestoredGeneration(instance),
      )
    }
    const exact = record.instanceId
      ? this.taskInstances.find(
          (instance) =>
            instance.instanceId === record.instanceId &&
            belongsToRestoredGeneration(instance),
        )
      : undefined
    return exact ? [exact] : []
  }

  private getAiRunRecoveryGeneration(
    record: AiRunRecord,
    instances: readonly TaskInstance[],
  ): { instanceId?: string; timerStartedAt?: number } {
    const exact = record.instanceId
      ? instances.find((instance) => instance.instanceId === record.instanceId)
      : undefined
    const owner = exact ?? instances.reduce<TaskInstance | undefined>(
      (earliest, instance) => {
        if (!earliest) return instance
        const earliestStartedAt =
          earliest.startTime?.getTime() ?? Number.POSITIVE_INFINITY
        const startedAt =
          instance.startTime?.getTime() ?? Number.POSITIVE_INFINITY
        return startedAt < earliestStartedAt ? instance : earliest
      },
      undefined,
    )
    return {
      instanceId: owner?.instanceId,
      timerStartedAt: owner?.startTime?.getTime(),
    }
  }

  /**
   * A renderer crash is not task completion. Return the restored timer to an
   * executable idle state without calling TaskExecutionService.stopInstance
   * (which would write a normal completion log and inflate completed counts).
   */
  private async resetInterruptedAiRunTimers(
    instances: readonly TaskInstance[],
    taskPath: string,
  ): Promise<void> {
    const uniqueInstances = [...new Set(instances)]
    if (uniqueInstances.length === 0) return
    const snapshots = uniqueInstances.map((instance) => ({
      instance,
      state: instance.state,
      startTime: instance.startTime,
      stopTime: instance.stopTime,
    }))
    const currentInstance = this.currentInstance
    for (const instance of uniqueInstances) {
      this.invalidateAiStartAttempt(instance)
      instance.state = 'idle'
      instance.startTime = undefined
      instance.stopTime = undefined
      if (this.currentInstance === instance) this.currentInstance = null
    }

    try {
      // Delete only this AI task's persisted records. Partial execution logs
      // are removed inside the same running-task mutation boundary and only
      // when a durable running record still exists. If another view already
      // completed the task and removed that record, this stale view is merely
      // idled and can never erase the legitimate completion log.
      await this.runningTasksService.deleteByInstanceOrPathStrict(
        { taskPath },
        async () => {
          for (const { instance, startTime } of snapshots) {
            const startedAt =
              startTime instanceof Date && Number.isFinite(startTime.getTime())
                ? this.formatDateKey(startTime)
                : this.getCurrentDateString()
            await this.removeTaskLogForInstanceOnDate(
              instance.instanceId,
              startedAt,
              instance.task?.taskId,
              instance.task?.path,
            )
          }
        },
      )
    } catch (error) {
      for (const snapshot of snapshots) {
        snapshot.instance.state = snapshot.state
        snapshot.instance.startTime = snapshot.startTime
        snapshot.instance.stopTime = snapshot.stopTime
      }
      this.currentInstance = currentInstance
      this.renderTaskList()
      throw error
    }
    this.renderTaskList()
  }

  /**
   * Each mounted TaskChute leaf owns different TaskInstance objects. After
   * the manager-wide durable repair settles, every leaf re-reads its current
   * list and applies the same idle transition locally.
   */
  private idleReconciledAiRunInstances(
    instances: readonly TaskInstance[],
  ): void {
    const runningInstances = [...new Set(instances)].filter(
      (instance) => instance.state === 'running',
    )
    if (runningInstances.length === 0) return
    for (const instance of runningInstances) {
      this.invalidateAiStartAttempt(instance)
      instance.state = 'idle'
      instance.startTime = undefined
      instance.stopTime = undefined
      if (this.currentInstance === instance) this.currentInstance = null
    }
    this.renderTaskList()
  }

  /**
   * Reconcile timers only after task loading has restored DayState. The
   * manager coordinates the durable mutation across all mounted views. Every
   * waiter then re-evaluates and clears its own independently restored
   * TaskInstance objects. A failed repair leaves the marker available for a
   * later reload.
   */
  private async reconcileInterruptedAiRunTasks(): Promise<void> {
    const manager = this.plugin.aiTaskManager
    if (!manager) return
    const recoveries: Promise<void>[] = []
    for (const record of manager.getRuns()) {
      if (
        record.status !== 'interrupted' ||
        record.host === 'shell'
      ) {
        continue
      }
      const targets = this.findRunningInstancesForAiRunRecovery(record)
      // Do not consume the durable marker from a leaf that cannot see the
      // timer (for example, a leaf displaying another date).
      if (targets.length === 0) continue
      recoveries.push(manager
        .coordinateInterruptedTaskStateReconciliation(
          record.id,
          this.getAiRunRecoveryGeneration(record, targets),
          () => this.resetInterruptedAiRunTimers(targets, record.taskPath),
        )
        .then((reconciled) => {
          if (!reconciled || this.plugin.aiTaskManager !== manager) return
          this.idleReconciledAiRunInstances(
            this.findRunningInstancesForAiRunRecovery(record),
          )
        })
        .catch((error: unknown) => {
          console.error(
            '[TaskChuteView] Failed to reconcile interrupted AI run task',
            error,
          )
        }))
    }
    await Promise.all(recoveries)
    if (this.plugin.aiTaskManager === manager) {
      await this.reconcileOrphanedAiRunTasks(manager)
    }
  }

  /**
   * localStorage and running-task.json are separate persistence boundaries.
   * If the AI workspace snapshot is unavailable after a crash, an AI timer
   * can otherwise be restored without any process/run capable of owning it.
   * Reset only strict ai_task instances with no active, pending, or recoverable
   * manager lifecycle; ordinary human tasks are never touched.
   */
  private async reconcileOrphanedAiRunTasks(manager: AiTaskManager): Promise<void> {
    const instancesByPath = new Map<string, TaskInstance[]>()
    for (const instance of this.taskInstances) {
      if (
        instance.state !== 'running' ||
        readAiTaskConfig(instance.task?.frontmatter) === null
      ) {
        continue
      }
      const taskPath = instance.task?.path
      if (!taskPath) continue
      const group = instancesByPath.get(taskPath) ?? []
      group.push(instance)
      instancesByPath.set(taskPath, group)
    }

    const recoveries: Promise<void>[] = []
    for (const [taskPath, instances] of instancesByPath) {
      const representative = instances[0]
      if (!representative) continue
      const owner = {
        instanceId: representative.instanceId,
        timerStartedAt: representative.startTime?.getTime(),
      }
      recoveries.push(manager
        .coordinateOrphanedTaskStateReconciliation(
          taskPath,
          owner,
          () => this.resetInterruptedAiRunTimers(instances, taskPath),
        )
        .then((reconciled) => {
          if (!reconciled || this.plugin.aiTaskManager !== manager) return
          this.idleReconciledAiRunInstances(
            this.taskInstances.filter(
              (instance) =>
                instance.state === 'running' &&
                instance.task?.path === taskPath &&
                readAiTaskConfig(instance.task?.frontmatter) !== null,
            ),
          )
        })
        .catch((error: unknown) => {
          console.error(
            '[TaskChuteView] Failed to reconcile orphaned AI task timer',
            error,
          )
        }))
    }
    await Promise.all(recoveries)
  }

  private notifyAiRunError(error: unknown): void {
    if (error instanceof AiBinaryNotFoundError) {
      new Notice(
        this.tv(
          "aiTask.notices.binaryNotFound",
          "AI CLI was not found: {host}. Install it or check PATH; use the advanced path fallback only for a custom location.",
          { host: error.host },
        ),
      )
      return
    }
    if (error instanceof AiPromptNotFoundError) {
      new Notice(
        this.tv(
          "aiTask.notices.noPrompt",
          'No prompt section found. Add a "## prompt" heading to the task note.',
        ),
      )
      return
    }
    if (error instanceof AiRunAlreadyActiveError) {
      new Notice(
        this.tv(
          "aiTask.notices.alreadyRunning",
          "An AI run is already in progress for this task.",
        ),
      )
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    new Notice(
      this.tv("aiTask.notices.startFailed", "Failed to start AI run: {message}", {
        message,
      }),
    )
  }

  private mountAiRunPane(): void {
    const manager = this.plugin.aiTaskManager
    if (!manager || !this.aiPaneContainer || this.aiRunPaneController) return

    // Duck-typed like the board view persistence above: App#saveLocalStorage
    // exists at runtime, but test doubles (and older typings) may lack it.
    const app = this.app as unknown as {
      saveLocalStorage?: (key: string, data: unknown) => void
      loadLocalStorage?: (key: string) => unknown
    }
    this.aiRunPaneController = new AiRunPaneController({
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      manager,
      createTerminalAdapter: () => createTerminalViewAdapter(),
      registerManagedDisposer: (cleanup) => this.registerManagedDisposer(cleanup),
      onStopAndCloseTaskRun: (record) => this.handleAiRunStopAndClose(record),
      onInterruptedTaskRun: () => {
        // Attach can fail after the mount-time recovery pass. Re-run it on
        // that transition so the TaskChute row/timer cannot remain Running.
        void this.reconcileInterruptedAiRunTasks()
      },
      saveLocalStorage: (key, value) => {
        if (typeof app.saveLocalStorage === 'function') {
          app.saveLocalStorage(key, value)
        }
      },
      loadLocalStorage: (key) =>
        typeof app.loadLocalStorage === 'function'
          ? app.loadLocalStorage(key)
          : null,
    })
    this.aiRunPaneController.mount(this.aiPaneContainer)
  }

  private unmountAiRunPane(): void {
    this.aiRunPaneController?.unmount()
    this.aiRunPaneController = null
  }

  /** Mirror of onRecipeFeatureSettingsChanged for the AI Task feature toggle */
  public onAiTaskSettingsChanged(): void {
    if (this.plugin.aiTaskManager) {
      this.mountAiRunPane()
      void this.reconcileInterruptedAiRunTasks()
    } else {
      this.unmountAiRunPane()
    }
    // The board view switch renders only while the feature is enabled.
    this.taskHeaderController.refreshAiTaskBoardSwitch()
    this.renderTaskList()
  }

  // Utility: reload tasks and immediately restore running-state from persistence
  public async reloadTasksAndRestore(
    options: { runBoundaryCheck?: boolean; clearDayStateCache?: DayStateCacheClearMode; queueIfInProgress?: boolean } = {},
  ): Promise<void> {
    await this.taskReloadCoordinator.reloadTasksAndRestore(options)
    await this.reconcileInterruptedAiRunTasks()
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

  public async removeRunningTaskRecord(params: { instanceId?: string; taskPath?: string; taskId?: string }): Promise<void> {
    await this.runningTasksService.deleteByInstanceOrPath(params)
  }

  public confirmStopNextDay(): Promise<boolean> {
    return showConfirmModal(this.app, {
      title: this.tv('forms.confirmStopNextDayTitle', 'Treat stop time as next day?'),
      message: this.tv(
        'forms.confirmStopNextDayMessage',
        'The stop time you entered is earlier than the start time. Save it as next day?',
      ),
      confirmText: this.tv('common.yes', 'Yes'),
      cancelText: this.tv('common.no', 'No'),
    })
  }

  public disambiguateStopTimeDate(
    sameDayDate: Date,
    nextDayDate: Date,
  ): Promise<'same-day' | 'next-day' | 'cancel'> {
    return showDisambiguateStopTimeDateModal(this.app, {
      sameDayDate,
      nextDayDate,
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
    })
  }

  public getOrderKey(inst: TaskInstance): string | null {
    const slot = inst.slotKey || "none"
    const dayState = this.getCurrentDayState()
    const isDuplicate = dayState.duplicatedInstances.some(
      (dup) => dup?.instanceId && dup.instanceId === inst.instanceId,
    )
    if (isDuplicate || (!inst.task?.taskId && !inst.task?.path)) {
      return inst.instanceId ? `${inst.instanceId}::${slot}` : null
    }
    if (inst.task?.taskId) {
      return `${inst.task.taskId}::${slot}`
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

  async loadTasks(options: { clearDayStateCache?: DayStateCacheClearMode } = {}): Promise<void> {
    await this.executionLogService.ensureReconciled()
    const clearMode = options.clearDayStateCache ?? 'current'
    if (clearMode === 'all') {
      this.dayStateManager.clear()
    } else if (clearMode === 'current') {
      this.dayStateManager.clear(this.getCurrentDateString())
    }

    // Write barrier: suppress disk writes during task loading to prevent
    // overwriting synced state with stale cache data (cross-device sync fix)
    this.dayStateManager.beginWriteBarrier()
    try {
      await this.ensureDayStateForCurrentDate()
      await loadTasksRefactored.call(this)
    } finally {
      try {
        await this.dayStateManager.endWriteBarrier()
      } catch (error) {
        console.warn('[TaskChuteView] endWriteBarrier failed during loadTasks:', error)
      }
    }

    // Process any external changes that arrived during the barrier
    await this.processBarrierPendingExternalChanges()

    // Build reminder schedules after loading tasks
    this.buildReminderSchedules()
  }

  /**
   * Process external changes that were queued during a write barrier.
   * Executes merge for pending month keys and triggers a reload if needed.
   */
  private async processBarrierPendingExternalChanges(): Promise<void> {
    const pendingMonthKeys = Array.from(this.pendingExternalMergeMonthKeys)
    const needsReload = this.pendingReloadAfterBarrier
    const requiresFullReload = this.pendingFullReloadAfterBarrier
    this.pendingExternalMergeMonthKeys.clear()
    this.pendingReloadAfterBarrier = false
    this.pendingFullReloadAfterBarrier = false

    if (this.isClosingOrClosed) return
    if (!needsReload) return
    if (requiresFullReload || pendingMonthKeys.length === 0) {
      this.queueReloadAfterBarrier('all')
      return
    }

    const dayStateService = this.plugin.dayStateService as {
      mergeExternalChange?: (monthKey: string) => Promise<{
        merged: unknown
        affectedDateKeys: string[]
      } | null>
    }

    if (typeof dayStateService.mergeExternalChange !== 'function') {
      this.queueReloadAfterBarrier('all')
      return
    }

    const affectedDates = new Set<string>()
    let mergeFailed = false

    for (const key of pendingMonthKeys) {
      try {
        const result = await dayStateService.mergeExternalChange(key)
        if (result && Array.isArray(result.affectedDateKeys)) {
          for (const dateKey of result.affectedDateKeys) {
            affectedDates.add(dateKey)
          }
        }
      } catch (error) {
        mergeFailed = true
        console.warn('[TaskChuteView] barrier pending mergeExternalChange failed:', key, error)
      }
    }

    if (mergeFailed) {
      this.queueReloadAfterBarrier('all')
      return
    }

    if (affectedDates.size === 0) {
      this.dayStateManager.clear()
    } else {
      for (const dateKey of affectedDates) {
        this.dayStateManager.clear(dateKey)
      }
    }
    this.queueReloadAfterBarrier('none')
  }

  private queueReloadAfterBarrier(clearDayStateCache: DayStateCacheClearMode): void {
    void this.reloadTasksAndRestore({
      runBoundaryCheck: false,
      clearDayStateCache,
      queueIfInProgress: true,
    }).catch((error) => {
      console.warn('[TaskChuteView] queued barrier reload failed:', error)
    })
  }

  /**
   * Schedule processing of an external state file change.
   * Handles write barrier queueing and debouncing.
   */
  private scheduleExternalStateChangeProcessing(
    filePath: string,
    dayStateService: {
      getMonthKeyFromPath?: (path: string) => string | null
      mergeExternalChange?: (monthKey: string) => Promise<{
        merged: unknown
        affectedDateKeys: string[]
      } | null>
    },
  ): void {
    if (this.isClosingOrClosed) {
      return
    }
    const monthKey = dayStateService.getMonthKeyFromPath?.(filePath)

    // If write barrier is active, queue the external change for processing after barrier ends
    if (this.dayStateManager.isBarrierActive()) {
      if (monthKey) {
        this.pendingExternalMergeMonthKeys.add(monthKey)
      } else {
        this.pendingFullReloadAfterBarrier = true
      }
      this.pendingReloadAfterBarrier = true
      return
    }

    if (monthKey) {
      this.stateFileModifyPendingMonthKeys.add(monthKey)
    } else {
      this.stateFileModifyRequiresFullReload = true
    }

    // Debounce to avoid excessive reloads during rapid changes
    if (this.stateFileModifyDebounceTimer) {
      const timeout = this.stateFileModifyDebounceTimer
      const timeoutWindow = this.stateFileModifyDebounceWindow ?? activeWindow
      this.stateFileModifyDebounceTimer = null
      this.stateFileModifyDebounceWindow = null
      timeoutWindow.clearTimeout(timeout)
    }
    const timeoutWindow = activeWindow
    this.stateFileModifyDebounceWindow = timeoutWindow
    this.stateFileModifyDebounceTimer = timeoutWindow.setTimeout(() => {
      this.stateFileModifyDebounceTimer = null
      this.stateFileModifyDebounceWindow = null
      if (this.isClosingOrClosed) {
        this.stateFileModifyPendingMonthKeys.clear()
        this.stateFileModifyRequiresFullReload = false
        return
      }

      const pendingMonthKeys = Array.from(this.stateFileModifyPendingMonthKeys)
      const requiresFullReload = this.stateFileModifyRequiresFullReload
      this.stateFileModifyPendingMonthKeys.clear()
      this.stateFileModifyRequiresFullReload = false

      if (!pendingMonthKeys.length && !requiresFullReload) {
        return
      }

      if (this.dayStateManager.isBarrierActive()) {
        for (const key of pendingMonthKeys) {
          this.pendingExternalMergeMonthKeys.add(key)
        }
        if (requiresFullReload) {
          this.pendingFullReloadAfterBarrier = true
        }
        this.pendingReloadAfterBarrier = true
        return
      }

      if (requiresFullReload || typeof dayStateService.mergeExternalChange !== 'function') {
        void this.reloadTasksAndRestore({
          runBoundaryCheck: false,
          clearDayStateCache: 'all',
        })
        return
      }

      void (async () => {
        const affectedDates = new Set<string>()
        let mergeFailed = false

        for (const key of pendingMonthKeys) {
          try {
            const result = await dayStateService.mergeExternalChange?.(key)
            if (result && Array.isArray(result.affectedDateKeys)) {
              for (const dateKey of result.affectedDateKeys) {
                affectedDates.add(dateKey)
              }
            }
          } catch (error) {
            mergeFailed = true
            console.warn('[TaskChuteView] mergeExternalChange failed for month', key, error)
          }
        }

        if (mergeFailed) {
          await this.reloadTasksAndRestore({
            runBoundaryCheck: false,
            clearDayStateCache: 'all',
          })
          return
        }

        for (const dateKey of affectedDates) {
          this.dayStateManager.clear(dateKey)
        }

        await this.reloadTasksAndRestore({
          runBoundaryCheck: false,
          clearDayStateCache: 'none',
        })
      })()
    }, 500) // 500ms debounce
  }

  private isPathWithinDirectory(path: string, directoryPath: string): boolean {
    const normalizedDirectoryPath = directoryPath.replace(/\/+$/, '')
    if (!normalizedDirectoryPath) {
      return false
    }
    return path === normalizedDirectoryPath || path.startsWith(`${normalizedDirectoryPath}/`)
  }

  /**
   * Build reminder schedules from loaded task instances.
   * Called after loadTasks to populate the reminder system with today's schedules.
   * Only builds schedules when viewing today's date to avoid scheduling
   * reminders from past/future dates to fire today.
   */
  private buildReminderSchedules(): void {
    const reminderManager = this.plugin.reminderManager
    if (!reminderManager) {
      return
    }

    // Only build schedules when viewing today's date
    const viewingDate = this.getCurrentDateString()
    const todayDate = this.getActualTodayString()
    if (viewingDate !== todayDate) {
      return
    }

    // Prepare task data for reminder system
    const tasksForReminder = this.taskInstances
      .map((inst) => {
        const normalized = normalizeReminderTime(inst.task.reminder_time)
        const isDuplicate = inst.isDuplicate === true || this.isDuplicateInstance(inst)
        const duplicateEntry = isDuplicate
          ? this.findDuplicateEntryForDate(inst, viewingDate)
          : undefined
        return {
          filePath: inst.task.path,
          ...(isDuplicate && inst.instanceId ? { instanceId: inst.instanceId } : {}),
          ...(isDuplicate ? { inheritsBaseReminder: duplicateEntry?.reminderTime === undefined } : {}),
          task: {
            name: inst.task.name || inst.task.displayTitle || 'Task',
            scheduledTime: inst.task.scheduledTime || '',
            ...(normalized ? { reminder_time: normalized } : {}),
            isRoutine: inst.task.isRoutine,
          },
        }
      })

    reminderManager.buildTodaySchedules(tasksForReminder)
  }

  /**
   * Get the actual today's date as YYYY-MM-DD string.
   * Unlike getCurrentDateString(), this always returns today regardless of navigation.
   */
  private getActualTodayString(): string {
    const now = new Date()
    const y = now.getFullYear()
    const m = (now.getMonth() + 1).toString().padStart(2, '0')
    const d = now.getDate().toString().padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  public async restoreDeletedTask(
    entry: DeletedInstance,
    dateKey?: string,
  ): Promise<boolean> {
    const targetDate = dateKey ?? this.getCurrentDateString()
    await this.ensureDayStateForDate(targetDate)
    const deleted = [...this.dayStateManager.getDeleted(targetDate)]

    // Find the entry to restore
    const targetIdx = deleted.findIndex((candidate) =>
      this.isSameDeletedEntry(candidate, entry),
    )
    if (targetIdx === -1) {
      return false
    }

    // Set restoredAt instead of removing the entry (for sync propagation)
    const current = deleted[targetIdx]
    const now = Date.now()
    const deletedAt = getEffectiveDeletedAt(current)
    const minRestoredAt = deletedAt > 0 ? deletedAt + 1 : now
    const prevRestoredAt = current.restoredAt ?? 0
    const restoredAt = Math.max(prevRestoredAt, now, minRestoredAt)
    deleted[targetIdx] = {
      ...current,
      restoredAt,
    }

    this.dayStateManager.setDeleted(deleted, targetDate)

    // hiddenRoutines のパスレベルエントリも同時に復元する
    // deleteRoutineTask() は hiddenRoutines と deletedInstances の両方に記録するが、
    // 復元時に hiddenRoutines を戻さないと isVisibleInstance() がブロックする
    if (entry.path) {
      const hiddenEntries = [...(this.dayStateManager.getHidden(targetDate) ?? [])]
      let hiddenChanged = false
      const restoredHidden = hiddenEntries.map((h) => {
        if (!h || typeof h === 'string') return h
        // 同じパスのパスレベル非表示エントリを復元
        if (h.path === entry.path && !h.instanceId) {
          const hHiddenAt = h.hiddenAt ?? 0
          const hPrevRestoredAt = h.restoredAt ?? 0
          const hMinRestoredAt = hHiddenAt > 0 ? hHiddenAt + 1 : now
          const hRestoredAt = Math.max(hPrevRestoredAt, now, hMinRestoredAt)
          if (hRestoredAt !== hPrevRestoredAt) {
            hiddenChanged = true
            return { ...h, restoredAt: hRestoredAt }
          }
        }
        return h
      })
      if (hiddenChanged) {
        this.dayStateManager.setHidden(restoredHidden, targetDate)
      }
    }

    await this.persistDayState(targetDate)
    const title = this.resolveDeletedTaskTitle(entry)
    if (typeof this.plugin._log === "function") {
      this.plugin._log("info", "Deleted task restored", {
        taskId: entry.taskId,
        path: entry.path,
        date: targetDate,
      })
    }
    new Notice(
      this.tv("notices.deletedTaskRestored", 'Restored "{title}" for {date}.', {
        title,
        date: targetDate,
      }),
    )
    await this.reloadTasksAndRestore({ runBoundaryCheck: false })
    return true
  }

  public generateInstanceId(task: TaskData, dateStr: string): string {
    // Generate a unique ID for this task instance
    return `${task.path}_${dateStr}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`
  }

  public isDuplicateInstance(inst: TaskInstance): boolean {
    return this.taskMutationService.isDuplicatedTask(inst)
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

  private isRecipeFeatureEnabled(): boolean {
    return this.plugin.settings.recipeFeatureEnabled === true
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
    slotKey?: string,
    options: Omit<DuplicateInstanceOptions, 'returnInstance' | 'slotKey'> = {},
  ): Promise<TaskInstance | void> {
    return this.taskMutationService.duplicateInstance(inst, {
      returnInstance: returnOnly,
      slotKey,
      ...options,
    })
  }

  private hasInstanceForPathToday(path: string): boolean {
    if (!path) return false
    return this.taskInstances.some((inst) => inst.task?.path === path)
  }

  private async duplicateInstanceForPath(
    path: string,
    options?: Omit<DuplicateInstanceOptions, 'returnInstance' | 'slotKey'>,
  ): Promise<CreatedTaskTarget | null> {
    if (!path) return null
    const existing = this.taskInstances.find((inst) => inst.task?.path === path)
    if (!existing) return null
    const slotKey = options?.scheduledTime ? undefined : 'none'
    const duplicated = await this.duplicateInstance(existing, true, slotKey, options)
    if (!duplicated) return null
    return {
      path: duplicated.task.path,
      instanceId: duplicated.instanceId,
    }
  }

  private async openGoogleCalendarExportForCreatedTask(target: CreatedTaskTarget): Promise<void> {
    if (this.plugin.settings.googleCalendar?.enabled !== true) {
      new Notice(
        this.tv(
          "calendar.export.disabled",
          "Googleカレンダー連携は設定で有効化してください",
        ),
      )
      return
    }

    const created = this.findCreatedTaskForCalendarExport(target)
    if (!created) {
      console.warn("[TaskChuteView] Created task was not found for calendar export", target)
      return
    }
    try {
      const settings = this.plugin.settings.googleCalendar ?? {}
      const event = await this.googleCalendarService.buildEventFromTask(
        created,
        settings,
        {
          viewDate: this.getViewDate(),
          defaultDurationMinutes: settings.defaultDurationMinutes ?? 60,
        },
      )
      const url = this.googleCalendarService.buildEventUrl(event)
      this.googleCalendarService.open(url)
      new Notice(this.tv("calendar.export.opened", "ブラウザでGoogleカレンダーを開きました"))
    } catch (error) {
      console.error("[TaskChuteView] Failed to open calendar export for created task", error)
      new Notice(
        this.tv(
          "calendar.export.cannotOpen",
          "プレビューを作成できません。開始時刻と所要時間を確認してください。",
        ),
      )
    }
  }

  private findCreatedTaskForCalendarExport(target: CreatedTaskTarget): TaskInstance | null {
    if (target.instanceId) {
      const byInstanceId = this.taskInstances.find((inst) => inst.instanceId === target.instanceId)
      if (byInstanceId) {
        return byInstanceId
      }
    }
    const matchingPath = this.taskInstances.filter((inst) => inst.task?.path === target.path)
    if (matchingPath.length === 0) {
      return null
    }
    return matchingPath.reduce((latest, candidate) => {
      const latestMillis = latest.createdMillis ?? 0
      const candidateMillis = candidate.createdMillis ?? 0
      return candidateMillis >= latestMillis ? candidate : latest
    }, matchingPath[0])
  }

  private invalidateDayStateCache(dateKey: string): void {
    try {
      this.dayStateManager.clear(dateKey)
    } catch (error) {
      console.warn('[TaskChuteView] Failed to invalidate day state cache', error)
    }
  }

  private async removeDuplicateInstanceFromCurrentDate(inst: TaskInstance): Promise<void> {
    try {
      await this.ensureDayStateForCurrentDate()
      const dayState = this.getCurrentDayState()
      const duplicates = Array.isArray(dayState.duplicatedInstances)
        ? dayState.duplicatedInstances
        : []
      if (!duplicates.length) {
        return
      }
      const dateKey = this.getCurrentDateString()
      const instanceId = inst.instanceId
      const taskPath = typeof inst.task?.path === 'string' ? inst.task.path : undefined
      const removedEntries: typeof duplicates = []
      const filtered = duplicates.filter((entry) => {
        if (!entry) return true
        if (instanceId && entry.instanceId === instanceId) {
          removedEntries.push(entry)
          return false
        }
        if (!instanceId && taskPath && entry.originalPath === taskPath) {
          removedEntries.push(entry)
          return false
        }
        return true
      })
      if (filtered.length !== duplicates.length) {
        dayState.duplicatedInstances = filtered
        const deletedEntries = Array.isArray(dayState.deletedInstances)
          ? [...dayState.deletedInstances]
          : []
        const now = Date.now()
        const resolvedTaskId = inst.task?.taskId
        const deletedKey = instanceId ?? taskPath
        const hasActiveDeletion = deletedEntries.some((entry) => {
          if (!entry || entry.deletionType !== 'temporary') return false
          if (instanceId && entry.instanceId === instanceId) {
            return isDeletedEntry(entry)
          }
          if (!instanceId && taskPath && entry.path === taskPath) {
            return isDeletedEntry(entry)
          }
          return false
        })
        if (!hasActiveDeletion && deletedKey) {
          const removed = removedEntries[0]
          deletedEntries.push({
            instanceId: removed?.instanceId ?? instanceId,
            path: removed?.originalPath ?? taskPath,
            deletionType: 'temporary',
            timestamp: now,
            deletedAt: now,
            taskId: resolvedTaskId,
          })
        }
        dayState.deletedInstances = deletedEntries
        await this.persistDayState(dateKey)
      }
    } catch (error) {
      console.warn('[TaskChuteView] Failed to remove duplicate entry for moved task', error)
      throw error
    }
  }

  private async hideRoutineInstanceForDate(inst: TaskInstance, dateKey: string): Promise<void> {
    try {
      const path = typeof inst.task?.path === 'string' ? inst.task.path : undefined
      const taskId = inst.task?.taskId
      if (!path && !taskId) {
        return
      }
      await this.ensureDayStateForDate(dateKey)
      const dayState = this.dayStateManager.getStateFor(dateKey)
      const deletedEntries = Array.isArray(dayState.deletedInstances)
        ? [...dayState.deletedInstances]
        : []

      const alreadyHidden = deletedEntries.some((entry) => {
        if (!entry) return false
        if (entry.deletionType !== 'permanent') {
          return false
        }
        const matches = (taskId && entry.taskId === taskId) || (!taskId && path && entry.path === path)
        if (!matches) {
          return false
        }
        if (isDeletedEntry(entry)) {
          return true
        }
        return isLegacyDeletionEntry(entry)
      })
      if (alreadyHidden) {
        return
      }

      const now = Date.now()
      deletedEntries.push({
        path,
        deletionType: 'permanent',
        timestamp: now,
        deletedAt: now,
        taskId,
      })
      this.dayStateManager.setDeleted(deletedEntries, dateKey)
      await this.persistDayState(dateKey)
    } catch (error) {
      console.warn('[TaskChuteView] Failed to hide routine instance for current date', error)
      throw error
    }
  }

  /**
   * Move a duplicate instance to a different date by adding it to the target date's dayState.
   * This does NOT modify the original task file's frontmatter.
   */
  private async moveDuplicateInstanceToDate(
    inst: TaskInstance,
    dateStr: string,
  ): Promise<void> {
    try {
      if (
        inst.state === 'running' &&
        dateStr === this.getCurrentDateString()
      ) {
        return
      }
      // Ensure dayState for target date exists
      await this.ensureDayStateForDate(dateStr)
      const targetDayState = this.dayStateManager.getStateFor(dateStr)
      const sourceEntry = this.findDuplicateEntryForDate(inst, this.getCurrentDateString())
      const scheduleOverrides = this.getDuplicateScheduleOverrides(inst, sourceEntry)

      // Create a new duplicate entry for the target date
      const newEntry: DayState['duplicatedInstances'][number] = {
        // A live AI run and running-task.json own the current instanceId.
        // Preserve it while the duplicate moves so the target row restores
        // to the same timer/run generation; idle duplicates may keep using a
        // freshly generated date-scoped identity.
        instanceId:
          inst.state === 'running' && inst.instanceId
            ? inst.instanceId
            : this.generateInstanceId(inst.task, dateStr),
        originalPath: inst.task.path,
        slotKey: inst.slotKey ?? 'none',
        originalSlotKey: inst.originalSlotKey ?? inst.slotKey ?? 'none',
        timestamp: Date.now(),
        createdMillis: Date.now(),
        originalTaskId: inst.task.taskId,
        ...scheduleOverrides,
      }

      // Add to target date's duplicatedInstances
      if (!Array.isArray(targetDayState.duplicatedInstances)) {
        targetDayState.duplicatedInstances = []
      }
      targetDayState.duplicatedInstances.push(newEntry)

      // Persist the target date's dayState
      await this.persistDayState(dateStr)
    } catch (error) {
      console.warn('[TaskChuteView] Failed to move duplicate instance to date', error)
      throw error
    }
  }

  private findDuplicateEntryForDate(
    inst: TaskInstance,
    dateKey: string,
  ): DayState['duplicatedInstances'][number] | undefined {
    const state = this.dayStateManager.getStateFor(dateKey)
    const entries = Array.isArray(state.duplicatedInstances)
      ? state.duplicatedInstances
      : []
    const instanceId = inst.instanceId
    const taskPath = typeof inst.task?.path === 'string' ? inst.task.path : undefined

    return entries.find((entry) => {
      if (!entry) return false
      if (instanceId && entry.instanceId === instanceId) {
        return true
      }
      return !instanceId && !!taskPath && entry.originalPath === taskPath
    })
  }

  private getDuplicateScheduleOverrides(
    inst: TaskInstance,
    sourceEntry?: DayState['duplicatedInstances'][number],
  ): { scheduledTime?: string | null; reminderTime?: string | null } {
    const overrides: { scheduledTime?: string | null; reminderTime?: string | null } = {}

    if (sourceEntry?.scheduledTime !== undefined) {
      overrides.scheduledTime = sourceEntry.scheduledTime
    } else if (!sourceEntry && typeof inst.task?.scheduledTime === 'string' && inst.task.scheduledTime.length > 0) {
      overrides.scheduledTime = inst.task.scheduledTime
    }

    if (sourceEntry?.reminderTime !== undefined) {
      overrides.reminderTime = sourceEntry.reminderTime
    } else if (!sourceEntry) {
      const normalized = normalizeReminderTime(inst.task?.reminder_time)
      if (normalized !== undefined) {
        overrides.reminderTime = normalized
      }
    }

    return overrides
  }

  private async moveNonRoutineSlotOverrideToDate(
    inst: TaskInstance,
    dateStr: string,
  ): Promise<void> {
    try {
      if (!inst?.task || inst.task.isRoutine === true) {
        return
      }
      const sourceDateKey = this.getCurrentDateString()
      if (!sourceDateKey || sourceDateKey === dateStr) {
        return
      }

      const taskPath = typeof inst.task.path === 'string' ? inst.task.path : ''
      const taskId = typeof inst.task.taskId === 'string' && inst.task.taskId.trim().length > 0
        ? inst.task.taskId
        : undefined
      const overrideKey = taskId ?? taskPath
      if (!overrideKey) {
        return
      }

      await this.ensureDayStateForDate(sourceDateKey)
      const sourceState = this.dayStateManager.getStateFor(sourceDateKey)
      const sourceSlot = sourceState.slotOverrides[overrideKey]
        ?? (taskId && taskPath ? sourceState.slotOverrides[taskPath] : undefined)
      if (typeof sourceSlot !== 'string') {
        return
      }

      const updatedAt = Date.now()
      delete sourceState.slotOverrides[overrideKey]
      if (taskId && taskPath && overrideKey !== taskPath) {
        delete sourceState.slotOverrides[taskPath]
      }
      if (!sourceState.slotOverridesMeta) {
        sourceState.slotOverridesMeta = {}
      }
      sourceState.slotOverridesMeta[overrideKey] = { slotKey: sourceSlot, updatedAt }
      if (taskId && taskPath && overrideKey !== taskPath) {
        sourceState.slotOverridesMeta[taskPath] = { slotKey: sourceSlot, updatedAt }
      }

      await this.ensureDayStateForDate(dateStr)
      const targetState = this.dayStateManager.getStateFor(dateStr)
      targetState.slotOverrides[overrideKey] = sourceSlot
      if (taskId && taskPath && overrideKey !== taskPath) {
        delete targetState.slotOverrides[taskPath]
      }
      if (!targetState.slotOverridesMeta) {
        targetState.slotOverridesMeta = {}
      }
      targetState.slotOverridesMeta[overrideKey] = { slotKey: sourceSlot, updatedAt }
      if (taskId && taskPath && overrideKey !== taskPath) {
        delete targetState.slotOverridesMeta[taskPath]
      }

      await this.persistDayState(sourceDateKey)
      await this.persistDayState(dateStr)
    } catch (error) {
      console.warn('[TaskChuteView] Failed to move non-routine slot override to date', error)
      throw error
    }
  }

  private async moveDuplicateEntryToDate(
    inst: TaskInstance,
    fromDateKey: string,
    toDateKey: string,
  ): Promise<boolean> {
    if (!inst || fromDateKey === toDateKey) {
      return false
    }
    const instanceId = inst.instanceId
    const taskPath = typeof inst.task?.path === 'string' ? inst.task.path : undefined

    await this.ensureDayStateForDate(fromDateKey)
    const sourceState = this.dayStateManager.getStateFor(fromDateKey)
    const sourceEntries = Array.isArray(sourceState.duplicatedInstances)
      ? sourceState.duplicatedInstances
      : []
    const sourceIndex = sourceEntries.findIndex((entry) => {
      if (!entry) return false
      if (instanceId && entry.instanceId === instanceId) {
        return true
      }
      if (!instanceId && taskPath && entry.originalPath === taskPath) {
        return true
      }
      return false
    })
    if (sourceIndex < 0) {
      return false
    }

    const [sourceEntry] = sourceEntries.splice(sourceIndex, 1)
    sourceState.duplicatedInstances = sourceEntries
    const sourceDeleted = Array.isArray(sourceState.deletedInstances)
      ? [...sourceState.deletedInstances]
      : []
    const sourceInstanceId = sourceEntry.instanceId ?? instanceId
    const sourcePath = sourceEntry.originalPath ?? taskPath
    const hasActiveDeletion = sourceDeleted.some((entry) => {
      if (!entry || entry.deletionType !== 'temporary') return false
      if (sourceInstanceId && entry.instanceId === sourceInstanceId) {
        return isDeletedEntry(entry)
      }
      if (!sourceInstanceId && sourcePath && entry.path === sourcePath) {
        return isDeletedEntry(entry)
      }
      return false
    })
    if ((sourceInstanceId || sourcePath) && !hasActiveDeletion) {
      const now = Date.now()
      sourceDeleted.push({
        instanceId: sourceInstanceId,
        path: sourcePath,
        deletionType: 'temporary',
        timestamp: now,
        deletedAt: now,
        taskId: sourceEntry.originalTaskId ?? inst.task?.taskId,
      })
      sourceState.deletedInstances = sourceDeleted
    }
    await this.persistDayState(fromDateKey)

    const resolvedInstanceId = sourceEntry.instanceId ?? instanceId
    const resolvedPath = sourceEntry.originalPath ?? taskPath
    if (!resolvedInstanceId || !resolvedPath) {
      return true
    }

    await this.ensureDayStateForDate(toDateKey)
    const targetState = this.dayStateManager.getStateFor(toDateKey)
    if (!Array.isArray(targetState.duplicatedInstances)) {
      targetState.duplicatedInstances = []
    }
    const alreadyExists = targetState.duplicatedInstances.some(
      (entry) => entry?.instanceId === resolvedInstanceId,
    )
    if (alreadyExists) {
      return true
    }

    const now = Date.now()
    const scheduleOverrides = this.getDuplicateScheduleOverrides(inst, sourceEntry)
    targetState.duplicatedInstances.push({
      instanceId: resolvedInstanceId,
      originalPath: resolvedPath,
      slotKey: inst.slotKey ?? sourceEntry.slotKey ?? 'none',
      originalSlotKey: inst.originalSlotKey ?? sourceEntry.originalSlotKey ?? inst.slotKey ?? 'none',
      timestamp: sourceEntry.timestamp ?? now,
      createdMillis: sourceEntry.createdMillis ?? now,
      originalTaskId: sourceEntry.originalTaskId ?? inst.task?.taskId,
      ...scheduleOverrides,
    })
    await this.persistDayState(toDateKey)
    return true
  }

  private async clearTaskDeletionForDate(inst: TaskInstance, dateKey: string): Promise<void> {
    try {
      const taskPath = typeof inst.task?.path === 'string' ? inst.task.path : undefined
      const taskId = inst.task?.taskId
      const instanceId = inst.instanceId
      if (!taskPath && !taskId && !instanceId) {
        return
      }

      await this.ensureDayStateForDate(dateKey)
      const dayState = this.dayStateManager.getStateFor(dateKey)
      const deletedEntries = Array.isArray(dayState.deletedInstances)
        ? dayState.deletedInstances
        : []
      const now = Date.now()
      let changed = false
      const updated = deletedEntries.reduce<DeletedInstance[]>((acc, entry) => {
        if (!entry) {
          changed = true
          return acc
        }

        let shouldRestore = false
        if (instanceId && entry.instanceId === instanceId) {
          shouldRestore = true
        }
        if (!shouldRestore && entry.deletionType === 'permanent') {
          if (taskId && entry.taskId === taskId) {
            shouldRestore = true
          } else if (taskPath && entry.path === taskPath) {
            shouldRestore = true
          }
        }

        if (shouldRestore) {
          const prevRestoredAt = entry.restoredAt ?? 0
          const deletedAt = getEffectiveDeletedAt(entry)
          const minRestoredAt = deletedAt > 0 ? deletedAt + 1 : now
          const nextRestoredAt = Math.max(prevRestoredAt, now, minRestoredAt)
          if (nextRestoredAt !== prevRestoredAt) {
            changed = true
            acc.push({
              ...entry,
              restoredAt: nextRestoredAt,
            })
            return acc
          }
        }

        acc.push(entry)
        return acc
      }, [])

      if (changed) {
        dayState.deletedInstances = updated
        await this.persistDayState(dateKey)
      }
    } catch (error) {
      console.warn('[TaskChuteView] Failed to clear task deletion for date', error)
    }
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
    const startGeneration = this.beginAiStartAttempt(inst)
    const manager = this.plugin.aiTaskManager
    const preflight = manager
      ? await this.prepareAiRunForInstance(inst, manager)
      : { kind: 'not-needed' as const }
    // A broken/missing recipe must fail closed before timer persistence.
    if (preflight.kind === 'failed') return
    let reservation: AiTaskStartReservation | undefined
    if (preflight.kind === 'ready' && manager) {
      try {
        reservation = this.reservePreparedAiRun(manager, preflight.prepared)
      } catch (error) {
        this.notifyAiRunError(error)
        return
      }
    }
    const originalWasKnownToView =
      this.taskInstances.includes(inst) ||
      this.linkedAiTaskCandidates.includes(inst)

    try {
      // A stop or a newer play action that happened during preflight wins.
      if (!this.isCurrentAiStartAttempt(inst, startGeneration)) return

      const snapshot = {
        state: inst.state,
        startTime: inst.startTime,
        stopTime: inst.stopTime,
        slotKey: inst.slotKey,
        originalSlotKey: inst.originalSlotKey,
        currentInstance: this.currentInstance,
      }
      const started = await this.taskExecutionService.startInstance(inst)
      // Fire the coupled AI run only when the human start actually happened
      // (the service resolves false on refusals like the future-date guard).
      if (!started) return

      let startedInstance = this.resolveCurrentAiStartInstance(
        inst,
        originalWasKnownToView,
      )
      if (
        !this.isCurrentAiStartAttempt(inst, startGeneration) ||
        !startedInstance
      ) {
        const rollbackTarget =
          startedInstance ?? (inst.state === 'running' ? inst : undefined)
        if (rollbackTarget?.state === 'running') {
          await this.rollbackAiTimerStart(rollbackTarget, snapshot)
        }
        return
      }

      if (preflight.kind === 'ready' && manager) {
        if (this.plugin.aiTaskManager !== manager) {
          await this.rollbackAiTimerStart(startedInstance, snapshot)
          return
        }
        const record = await this.startAiRunWithManager(
          startedInstance,
          manager,
          {},
          preflight.prepared,
          reservation,
        )
        if (!record) {
          await this.rollbackAiTimerStart(startedInstance, snapshot)
          return
        }
        const startedInstanceWasKnownToView =
          this.taskInstances.includes(startedInstance) ||
          this.linkedAiTaskCandidates.includes(startedInstance)
        startedInstance = this.resolveCurrentAiStartInstance(
          startedInstance,
          startedInstanceWasKnownToView,
        )
        if (
          this.plugin.aiTaskManager !== manager ||
          !this.isCurrentAiStartAttempt(inst, startGeneration) ||
          !startedInstance
        ) {
          // The old manager may already have spawned while settings reload
          // replaced it, or stop may have won startPreparedRun's async edge.
          manager.requestStopForTask(inst.task.path)
          const rollbackTarget =
            startedInstance ?? (inst.state === 'running' ? inst : undefined)
          if (rollbackTarget?.state === 'running') {
            await this.rollbackAiTimerStart(rollbackTarget, snapshot)
          }
          return
        }
      } else {
        this.maybeStartAiRunForInstance(startedInstance)
      }
      await this.aiTaskObsidianLinkCoordinator.handleSourceStarted(
        startedInstance,
      )
    } finally {
      if (manager) {
        this.releasePreparedAiRunReservation(manager, reservation)
      }
    }
  }

  async stopInstance(inst: TaskInstance, stopTime?: Date): Promise<void> {
    // Invalidate even when TaskExecutionService later reports a no-op: an
    // idle instance can still have an asynchronous AI preflight in progress.
    this.invalidateAiStartAttempt(inst)
    const stopped = await this.taskExecutionService.stopInstance(inst, stopTime)
    // Kill the coupled AI run only when the instance actually transitioned
    // running -> done (a no-op stop must not touch the AI run).
    if (stopped) {
      this.maybeStopAiRunForInstance(inst)
      await this.aiTaskObsidianLinkCoordinator.handleSourceStopped(inst)
    }
    const viewDate = this.getViewDate()
    const today = new Date()
    const isTodayView =
      viewDate.getFullYear() === today.getFullYear() &&
      viewDate.getMonth() === today.getMonth() &&
      viewDate.getDate() === today.getDate()
    if (isTodayView && this.hasRunningInstances()) {
      this.timerService?.restart()
    }
  }

  public async handleCrossDayStart(payload: CrossDayStartPayload): Promise<void> {
    const { today, todayKey, instance } = payload
    const previousDateKey = this.getCurrentDateString()
    const movedDuplicate = await this.moveDuplicateEntryToDate(instance, previousDateKey, todayKey)
    // 重複インスタンスは duplicatedInstances / deletedInstances で日跨ぎ移動する。
    // ベース routine のみ、前日を非表示化して二重表示を防ぐ。
    if (instance.task?.isRoutine && !movedDuplicate) {
      await this.hideRoutineInstanceForDate(instance, previousDateKey)
    }
    await this.clearTaskDeletionForDate(instance, todayKey)
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
      const viewDateString = this.getCurrentDateString()
      await this.runningTasksService.save(runningInstances, viewDateString)
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
        .filter(
          (inst) =>
            inst.deletionType === "permanent" &&
            (isDeletedEntry(inst) || isLegacyDeletionEntry(inst)),
        )
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
    taskId?: string,
  ): Promise<void> {
    try {
      if (!instanceId) return
      const dateStr = this.getCurrentDateString()
      await this.removeTaskLogForInstanceOnDate(instanceId, dateStr, taskId)
    } catch (e) {
      console.error(
        "[TaskChute] removeTaskLogForInstanceOnCurrentDate failed:",
        e,
      )
    }
  }

  public async removeTaskLogForInstanceOnDate(
    instanceId: string,
    dateKey: string,
    taskId?: string,
    taskPath?: string,
  ): Promise<void> {
    const resolvedTaskId =
      taskId ??
      this.taskInstances.find((inst) => inst.instanceId === instanceId)?.task?.taskId ??
      this.currentInstance?.task?.taskId
    const resolvedPath =
      taskPath ??
      this.taskInstances.find((inst) => inst.instanceId === instanceId)?.task?.path ??
      this.currentInstance?.task?.path
    await this.executionLogService.removeTaskLogForInstanceOnDate(
      instanceId,
      dateKey,
      resolvedTaskId,
      resolvedPath,
    )
  }

  private createRunningInstanceFromRecord(record: RunningTaskRecord): TaskInstance {
    const task: TaskData = {
      file: null,
      frontmatter: {},
      path: record.taskPath,
      name: record.taskTitle,
      displayTitle: record.taskTitle,
      isRoutine: record.isRoutine === true,
      taskId: record.taskId,
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

      await this.runningTasksService.save(
        [...preserved, instanceForSave],
        todayKey,
      )
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

  private showScheduledTimeEditModal(inst: TaskInstance): void {
    this.taskTimeController.showScheduledTimeEditModal(inst)
  }

  private showStartTimePopup(inst: TaskInstance, anchor: HTMLElement): void {
    this.taskTimeController.showStartTimePopup(inst, anchor)
  }

  private showStopTimePopup(inst: TaskInstance, anchor: HTMLElement): void {
    this.taskTimeController.showStopTimePopup(inst, anchor)
  }

  private showReminderSettingsModal(inst: TaskInstance): void {
    this.showReminderSettingsDialog(inst)
  }

  private showReminderSettingsDialog(inst: TaskInstance): void {
    const currentTime = normalizeReminderTime(inst.task.reminder_time)
    const scheduledTime = inst.task.scheduledTime
    const defaultMinutesBefore = this.plugin.settings.defaultReminderMinutes ?? 5

    const modal = new ReminderSettingsModal(this.app, {
      currentTime: currentTime || undefined,
      scheduledTime: scheduledTime || undefined,
      defaultMinutesBefore,
      onSave: (time: string) => {
        void this.updateTaskReminderTime(inst, time)
      },
      onClear: () => {
        void this.updateTaskReminderTime(inst, null)
      },
    })
    modal.open()
  }

  private showRecipeSelectModal(inst: TaskInstance): void {
    if (!this.isRecipeFeatureEnabled()) return
    new RecipeSelectModal(this.app, {
      service: this.recipeService,
      instance: inst,
      onAssigned: () => this.reloadTasksAndRestore({ runBoundaryCheck: true }),
    }).open()
  }

  private showRecipeRunPopover(inst: TaskInstance, anchor: HTMLElement): void {
    if (!this.isRecipeFeatureEnabled()) return
    void this.recipeRunPopover.show(inst, anchor)
  }

  private async getRecipeProgressSummary(inst: TaskInstance): Promise<{ total: number; checked: number } | null> {
    if (!this.isRecipeFeatureEnabled()) return null
    const recipePath = inst.task.recipePath
    if (!recipePath) return null
    const recipe = await this.recipeService.loadRecipe(recipePath)
    const key = createRecipeProgressKeyForInstance(inst, recipe.path)
    const progress = this.dayStateManager.getRecipeProgress(this.getCurrentDateString())[key]
    const validStepIds = new Set(recipe.steps.map((step) => step.id))
    const checked = (progress?.checkedStepIds ?? []).filter((stepId) => validStepIds.has(stepId)).length
    return {
      total: recipe.steps.length,
      checked,
    }
  }

  private async updateTaskScheduledTime(
    inst: TaskInstance,
    time: string | undefined,
  ): Promise<boolean> {
    await this.ensureDayStateForCurrentDate()
    const dateKey = this.getCurrentDateString()
    const duplicateEntry = this.findDuplicateEntryForDate(inst, dateKey)
    if (!duplicateEntry) {
      return false
    }

    this.detachTaskDataForDuplicateOverride(inst)
    duplicateEntry.scheduledTime = time ?? null
    this.applyScheduledTimeToInstance(inst, time)
    await this.persistDayState(dateKey)
    return true
  }

  private async updateTaskReminderTime(inst: TaskInstance, time: string | null): Promise<void> {
    try {
      await this.ensureDayStateForCurrentDate()
      const dateKey = this.getCurrentDateString()
      const duplicateEntry = this.findDuplicateEntryForDate(inst, dateKey)
      const reminderInstanceId = duplicateEntry && inst.instanceId ? inst.instanceId : undefined

      if (duplicateEntry) {
        this.detachTaskDataForDuplicateOverride(inst)
        duplicateEntry.reminderTime = time
        await this.persistDayState(dateKey)
      } else {
        const file = inst.task.file
        if (!file) {
          new Notice(this.tv('notices.taskFileMissing', 'Task file not found'))
          return
        }

        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          if (time === null) {
            delete frontmatter.reminder_time
          } else {
            frontmatter.reminder_time = time
          }
        })
      }

      this.applyReminderTimeToInstance(inst, time)
      if (!duplicateEntry) {
        this.applyReminderTimeToInheritedDuplicateInstances(inst, time, dateKey)
      }

      // Update the reminder schedule only when viewing today
      // (editing reminders for other dates should not schedule them for today)
      const viewingDate = this.getCurrentDateString()
      const todayDate = this.getActualTodayString()
      if (viewingDate === todayDate) {
        this.plugin.reminderManager?.onTaskReminderTimeChanged(
          inst.task.path,
          time,
          inst.task.name || inst.task.displayTitle || 'Task',
          inst.task.scheduledTime || '',
          reminderInstanceId,
        )
      }

      // Re-render to show the reminder icon
      this.renderTaskList()

      const message = time === null
        ? this.tv('messages.reminderCleared', 'Reminder cleared')
        : this.tv('messages.reminderSet', 'Reminder set for {time}', { time })
      new Notice(message)
    } catch (error) {
      console.error('[TaskChute] Failed to update reminder:', error)
      new Notice(this.tv('errors.reminderUpdateFailed', 'Failed to update reminder'))
    }
  }

  private applyReminderTimeToInheritedDuplicateInstances(
    baseInst: TaskInstance,
    time: string | null,
    dateKey: string,
  ): void {
    const basePath = baseInst.task?.path
    if (!basePath) {
      return
    }

    for (const candidate of this.taskInstances) {
      if (candidate === baseInst || candidate.task?.path !== basePath) {
        continue
      }

      const duplicateEntry = this.findDuplicateEntryForDate(candidate, dateKey)
      if (!duplicateEntry || duplicateEntry.reminderTime !== undefined) {
        continue
      }

      this.applyReminderTimeToInstance(candidate, time)
    }
  }

  private detachTaskDataForDuplicateOverride(inst: TaskInstance): void {
    inst.task = {
      ...inst.task,
      frontmatter: {
        ...(inst.task.frontmatter ?? {}),
      },
    }
  }

  private applyScheduledTimeToInstance(
    inst: TaskInstance,
    time: string | undefined,
  ): void {
    if (time === undefined) {
      delete inst.task.scheduledTime
      if (inst.task.frontmatter) {
        delete inst.task.frontmatter.scheduled_time
        delete inst.task.frontmatter['開始時刻']
      }
      return
    }

    inst.task.scheduledTime = time
    if (!inst.task.frontmatter) {
      inst.task.frontmatter = {}
    }
    inst.task.frontmatter.scheduled_time = time
    delete inst.task.frontmatter['開始時刻']
  }

  private applyReminderTimeToInstance(inst: TaskInstance, time: string | null): void {
    if (time === null) {
      delete inst.task.reminder_time
      if (inst.task.frontmatter) {
        delete inst.task.frontmatter.reminder_time
      }
      return
    }

    inst.task.reminder_time = time
    if (!inst.task.frontmatter) {
      inst.task.frontmatter = {}
    }
    inst.task.frontmatter.reminder_time = time
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

    // State file modification/creation listener for cross-device sync support
    // When the state file is modified externally (e.g., via Obsidian Sync),
    // merge changes using OR-Set + Tombstone conflict resolution
    const handleExternalStateChange = (file: TAbstractFile) => {
      if (this.isClosingOrClosed) return
      if (!(file instanceof TFile)) return
      if (!file.path.endsWith("-state.json")) return

      // Check if this is our state file (under logDataPath)
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      if (!this.isPathWithinDirectory(file.path, logDataPath)) return

      const dayStateService = this.plugin.dayStateService as {
        consumeLocalStateWrite?: (path: string, content?: string, maxRecordedAt?: number) => boolean
        getMonthKeyFromPath?: (path: string) => string | null
        mergeExternalChange?: (monthKey: string) => Promise<{
          merged: unknown
          affectedDateKeys: string[]
        } | null>
      }
      const eventTimestamp = Date.now()

      // Read file content asynchronously for hash-based self-write detection
      void (async () => {
        let fileContent: string | undefined
        try {
          fileContent = await this.app.vault.read(file)
        } catch {
          // If read fails, treat as external change (safe side)
        }
        if (this.isClosingOrClosed) {
          return
        }
        if (dayStateService.consumeLocalStateWrite?.(file.path, fileContent, eventTimestamp)) {
          return
        }
        this.scheduleExternalStateChangeProcessing(file.path, dayStateService)
      })()
    }

    // Listen for both modify and create events
    // Obsidian Sync may delete and recreate files during sync
    const stateModifyRef = this.app.vault.on("modify", handleExternalStateChange)
    const stateCreateRef = this.app.vault.on("create", handleExternalStateChange)
    this.registerManagedEvent(stateModifyRef)
    this.registerManagedEvent(stateCreateRef)

    // Handle state file deletion (Obsidian Sync may delete files during sync)
    const handleStateFileDelete = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return
      if (!file.path.endsWith("-state.json")) return
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      if (!this.isPathWithinDirectory(file.path, logDataPath)) return

      if (this.dayStateManager.isBarrierActive()) {
        this.pendingReloadAfterBarrier = true
        this.pendingFullReloadAfterBarrier = true
        return
      }

      // State file deleted — clear cache for the affected month and reload
      this.dayStateManager.clear()
      void this.reloadTasksAndRestore({
        runBoundaryCheck: false,
        clearDayStateCache: 'all',
      })
    }

    // Handle state file rename
    const handleStateFileRename = (file: TAbstractFile, oldPath: string) => {
      if (!(file instanceof TFile)) return
      if (!oldPath.endsWith("-state.json") && !file.path.endsWith("-state.json")) return
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      if (
        !this.isPathWithinDirectory(oldPath, logDataPath)
        && !this.isPathWithinDirectory(file.path, logDataPath)
      ) return

      if (this.dayStateManager.isBarrierActive()) {
        this.pendingReloadAfterBarrier = true
        this.pendingFullReloadAfterBarrier = true
        return
      }

      // State file renamed — clear all caches and reload
      this.dayStateManager.clear()
      void this.reloadTasksAndRestore({
        runBoundaryCheck: false,
        clearDayStateCache: 'all',
      })
    }

    const stateDeleteRef = this.app.vault.on("delete", handleStateFileDelete)
    const stateRenameRef = this.app.vault.on("rename", handleStateFileRename)
    this.registerManagedEvent(stateDeleteRef)
    this.registerManagedEvent(stateRenameRef)
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
    void this.reloadTasksAndRestore({ runBoundaryCheck: true }).then(() => {
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
    return this.sectionConfig.getSlotKeys()
  }

  public getSectionConfig(): SectionConfigService {
    return this.sectionConfig
  }

  async onSectionSettingsChanged(): Promise<void> {
    this.sectionConfig.updateBoundaries(this.plugin.settings.customSections)
    await this.reloadTasksAndRestore({ runBoundaryCheck: true })
  }

  public onRecipeFeatureSettingsChanged(): void {
    this.recipeRunPopover.close()
    this.navigationController.refreshNavigationItems()
    this.renderTaskList()
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

  public registerManagedDisposer(cleanup: () => void): () => void {
    let active = true
    const managedCleanup = (): void => {
      if (!active) return
      active = false
      cleanup()
    }
    this.managedDisposers.push(managedCleanup)
    return () => {
      if (!active) return
      active = false
      const index = this.managedDisposers.indexOf(managedCleanup)
      if (index >= 0) this.managedDisposers.splice(index, 1)
    }
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

  /**
   * Keep the task name accent readable against the theme background, and
   * recompute whenever the user switches theme or edits a snippet.
   */
  private setupAccentContrast(): void {
    this.accentContrastController.apply()

    const workspace = this.app?.workspace
    if (typeof workspace?.on !== "function") return

    this.registerManagedEvent(
      workspace.on("css-change", () => {
        this.accentContrastController.apply()
      }),
    )
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
      window.clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    if (this.boundaryCheckTimeout) {
      const timeout = this.boundaryCheckTimeout
      const timeoutWindow = this.boundaryCheckWindow ?? activeWindow
      this.boundaryCheckTimeout = null
      this.boundaryCheckWindow = null
      timeoutWindow.clearTimeout(timeout)
    }

    if (this.renderDebounceTimer) {
      window.clearTimeout(this.renderDebounceTimer)
      this.renderDebounceTimer = null
    }

    if (this.stateFileModifyDebounceTimer) {
      const timeout = this.stateFileModifyDebounceTimer
      const timeoutWindow = this.stateFileModifyDebounceWindow ?? activeWindow
      this.stateFileModifyDebounceTimer = null
      this.stateFileModifyDebounceWindow = null
      timeoutWindow.clearTimeout(timeout)
    }
    this.stateFileModifyPendingMonthKeys.clear()
    this.stateFileModifyRequiresFullReload = false

    // TimerService dispose
    this.timerService?.dispose()
    this.timerService = null
  }

  // Styles are provided by styles.css; dynamic CSS injection removed

  private async deleteTask(inst: TaskInstance): Promise<void> {
    const wasRunning = inst.state === 'running'
    const deleted = await this.taskMutationService.deleteTask(inst)
    // Deleting a running instance never goes through stopInstance, so stop
    // the coupled AI run here (otherwise it would keep running orphaned).
    if (wasRunning && deleted) {
      this.maybeStopAiRunForInstance(inst)
      await this.aiTaskObsidianLinkCoordinator.handleSourceStopped(inst)
    }
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
    await this.deleteTask(inst)
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<void> {
    await this.deleteTask(inst)
  }

  private showTaskContextMenu(event: MouseEvent, inst: TaskInstance): void {
    this.taskContextMenuController.show(event, inst)
  }

  private openGoogleCalendarExport(inst: TaskInstance): void {
    if (this.plugin.settings.googleCalendar?.enabled !== true) {
      new Notice(
        this.tv(
          "calendar.export.disabled",
          "Googleカレンダー連携は設定で有効化してください",
        ),
      )
      return
    }

    const modal = new CalendarExportModal({
      app: this.app,
      service: this.googleCalendarService,
      instance: inst,
      viewDate: this.getViewDate(),
      settings: this.plugin.settings.googleCalendar ?? {},
      tv: (key, fallback, vars) => this.tv(key, fallback, vars),
      getDisplayTitle: (instance) => this.getInstanceDisplayTitle(instance),
      isRoutine: inst.task.isRoutine === true,
      onMoveNonRoutineDate: async (dateKey) => {
        // Move task to target date, then jump view to that date
        await this.taskScheduleController.moveTaskToDate(inst, dateKey)
        this.currentDate = this.parseDateString(dateKey)
        this.currentDayState = null
        this.currentDayStateKey = null
        await this.reloadTasksAndRestore({ runBoundaryCheck: true })
      },
    })
    modal.open()
  }

  private handleDragOver(
    e: DragPointer,
    taskItem: HTMLElement,
    inst: TaskInstance,
  ): void {
    this.taskDragController.handleDragOver(e, taskItem, inst)
  }

  private handleDrop(
    e: DragPointer,
    taskItem: HTMLElement,
    targetInst: TaskInstance,
    payload?: string,
  ): void {
    this.taskDragController.handleDrop(e, taskItem, targetInst, payload)
  }

  private handleSlotDrop(e: DragPointer, slot: string, payload?: string): void {
    this.taskDragController.handleSlotDrop(e, slot, payload)
  }

  private async deleteInstance(inst: TaskInstance): Promise<void> {
    const wasRunning = inst.state === 'running'
    const deleted = await this.taskMutationService.deleteInstance(inst)
    // Same reasoning as deleteTask: a deleted running instance must not
    // leave its coupled AI run orphaned.
    if (wasRunning && deleted) {
      this.maybeStopAiRunForInstance(inst)
      await this.aiTaskObsidianLinkCoordinator.handleSourceStopped(inst)
    }
  }

  private async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    // AI stop coupling happens via the TaskTimeController host callback
    // (onInstanceResetToIdle), which also covers the controller-internal
    // reset paths (start-time popup clear, TimeEditModal).
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

  private resolveDeletedTaskTitle(entry: DeletedInstance): string {
    if (entry.taskId) {
      const match = this.tasks.find((task) => task?.taskId === entry.taskId)
      if (match) {
        return (
          match.displayTitle ??
          match.name ??
          this.extractNameFromPath(match.path)
        )
      }
    }
    if (entry.path) {
      return this.extractNameFromPath(entry.path)
    }
    if (entry.instanceId) {
      return entry.instanceId
    }
    if (entry.taskId) {
      return entry.taskId
    }
    return this.tv("restoreModal.unknownTask", "Unknown task")
  }

  private extractNameFromPath(path?: string): string {
    if (!path) {
      return this.tv("restoreModal.unknownTask", "Unknown task")
    }
    const filename = path.split("/").pop() ?? path
    return filename.replace(/\.md$/i, "")
  }

  private buildTaskPathFromName(taskName: string): string | null {
    const trimmed = taskName.trim()
    if (!trimmed) {
      return null
    }
    const validation = this.getTaskNameValidator().validate(trimmed)
    if (!validation.isValid) {
      return null
    }
    const folder = this.plugin.pathManager.getTaskFolderPath?.() ?? "TaskChute/Task"
    const normalizedFolder = folder.endsWith("/") ? folder.slice(0, -1) : folder
    return `${normalizedFolder}/${trimmed}.md`
  }

  private findDeletedTaskRestoreCandidate(taskName: string): DeletedTaskRestoreCandidate | null {
    const path = this.buildTaskPathFromName(taskName)
    if (!path) {
      return null
    }
    const dateKey = this.getCurrentDateString()
    const deletedEntries = this.dayStateManager.getDeleted(dateKey)
    const match = deletedEntries.find(
      (entry) =>
        entry?.deletionType === "permanent" &&
        entry.path === path &&
        (isDeletedEntry(entry) || isLegacyDeletionEntry(entry)),
    )
    if (!match) {
      return null
    }
    const fileExists = Boolean(this.app.vault.getAbstractFileByPath(path))
    return {
      entry: match,
      displayTitle: this.extractNameFromPath(path),
      fileExists,
    }
  }

  private async restoreDeletedTaskCandidate(candidate: DeletedTaskRestoreCandidate): Promise<boolean> {
    await this.ensureDayStateForCurrentDate()
    const dateKey = this.getCurrentDateString()
    const restored = await this.restoreDeletedTask(candidate.entry, dateKey)
    if (!restored) {
      return false
    }
    const path = candidate.entry.path
    if (path) {
      const existing = this.app.vault.getAbstractFileByPath(path)
      if (!existing || !(existing instanceof TFile)) {
        const taskName = this.extractNameFromPath(path)
        const basename = this.extractNameFromPath(path)
        try {
          await this.taskCreationService.createTaskFile(taskName, dateKey, undefined, {
            taskId: candidate.entry.taskId,
            basename,
          })
        } catch (error) {
          console.warn("[TaskChuteView] Failed to recreate task file during restore", error)
          return false
        }
      }
    }
    return true
  }

  private isSameDeletedEntry(a: DeletedInstance, b: DeletedInstance): boolean {
    if (a.taskId && b.taskId && a.taskId === b.taskId) return true
    if (a.instanceId && b.instanceId && a.instanceId === b.instanceId) return true
    if (a.path && b.path && a.path === b.path) {
      const aTime = getEffectiveDeletedAt(a)
      const bTime = getEffectiveDeletedAt(b)
      if (aTime > 0 && bTime > 0) {
        return aTime === bTime
      }
      return true
    }
    return false
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
        task.frontmatter = metadata
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
