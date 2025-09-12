import { ItemView, WorkspaceLeaf, TFile, TFolder, Notice, normalizePath } from 'obsidian';
import { calculateNextBoundary, getCurrentTimeSlot, TimeBoundary } from '../utils/time';
import { LogView } from './LogView';
import { ReviewService } from '../services/ReviewService';
import { HeatmapService } from '../services/HeatmapService';
import { 
  TaskData, 
  TaskInstance, 
  DeletedInstance, 
  HiddenRoutine, 
  DuplicatedInstance, 
  NavigationState, 
  TaskNameValidator,
  AutocompleteInstance 
} from '../types';
import { TASKCHUTE_FULL_CSS } from '../styles/full-css';
import { loadTasksRefactored } from './TaskChuteView.helpers';
import { ProjectNoteSyncManager } from '../managers/ProjectNoteSyncManager';

// VIEW_TYPE_TASKCHUTE is defined in main.ts

class NavigationStateManager implements NavigationState {
  selectedSection: 'routine' | 'review' | 'log' | 'project' | null = null;
  isOpen: boolean = false;
}

export class TaskChuteView extends ItemView {
  // Core Properties
  private plugin: any;
  private tasks: TaskData[] = [];
  private taskInstances: TaskInstance[] = [];
  private currentInstance: TaskInstance | null = null;
  private globalTimerInterval: NodeJS.Timeout | null = null;
  private logView: any = null;
  
  // Date Navigation
  private currentDate: Date;
  
  // UI Elements
  private taskList: HTMLElement;
  private navigationPanel: HTMLElement;
  private navigationOverlay: HTMLElement;
  
  // State Management
  private useOrderBasedSort: boolean;
  private navigationState: NavigationStateManager;
  private selectedTaskInstance: TaskInstance | null = null;
  private autocompleteInstances: AutocompleteInstance[] = [];
  
  // Boundary Check (idle-task-auto-move feature)
  private boundaryCheckTimeout: NodeJS.Timeout | null = null;
  
  // Debounce Timer
  private renderDebounceTimer: NodeJS.Timeout | null = null;

  // Task Name Validator
  private TaskNameValidator: TaskNameValidator = {
    INVALID_CHARS_PATTERN: /[:|\/\\#^]/g,
    
    validate(taskName: string) {
      const invalidChars = taskName.match(this.INVALID_CHARS_PATTERN);
      return {
        isValid: !invalidChars,
        invalidChars: invalidChars ? [...new Set(invalidChars)] : [],
      };
    },
    
    getErrorMessage(invalidChars: string[]) {
      return `使用できない文字が含まれています: ${invalidChars.join(", ")}`;
    }
  };

  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
    
    // Initialize current date
    const today = new Date();
    this.currentDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    
    // Initialize sort preference
    this.useOrderBasedSort = 
      localStorage.getItem("taskchute-use-order-sort") !== "false";
    
    // Initialize navigation state
    this.navigationState = new NavigationStateManager();
  }

  getViewType(): string {
    return "taskchute-view";
  }

  getDisplayText(): string {
    return "TaskChute";
  }

  getIcon(): string {
    return "checkmark";
  }

  // ===========================================
  // Core Lifecycle Methods
  // ===========================================

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();

    // Schedule boundary check for idle-task-auto-move
    this.scheduleBoundaryCheck();

    await this.setupUI(container);
    await this.loadTasks();
    // Apply boundary check immediately on open (today only)
    this.checkBoundaryTasks();
    
    // Restore any running tasks from persistence
    await this.restoreRunningTaskState();
    
    this.applyStyles();
    this.setupResizeObserver();
    this.initializeNavigationEventListeners();
    this.setupEventListeners();
  }

  async onClose(): Promise<void> {
    // Clean up autocomplete instances
    this.cleanupAutocompleteInstances();
    
    // Clean up timers
    this.cleanupTimers();
  }

  // ===========================================
  // UI Setup Methods
  // ===========================================

  private async setupUI(container: HTMLElement): Promise<void> {
    // Top bar container (date navigation and drawer icon)
    const topBarContainer = container.createEl("div", {
      cls: "top-bar-container",
    });

    this.createDrawerToggle(topBarContainer);
    this.createDateNavigation(topBarContainer);
    this.createActionButtons(topBarContainer);

    // Main container
    const mainContainer = container.createEl("div", {
      cls: "taskchute-container",
    });

    // Content container for navigation panel and task list
    const contentContainer = mainContainer.createEl("div", {
      cls: "main-container",
    });

    // Navigation overlay and panel
    this.createNavigationUI(contentContainer);
    
    // Task list container
    const taskListContainer = contentContainer.createEl("div", {
      cls: "task-list-container",
    });

    this.taskList = taskListContainer.createEl("div", { cls: "task-list" });
  }

  private createDrawerToggle(topBarContainer: HTMLElement): void {
    const drawerToggle = topBarContainer.createEl("button", {
      cls: "drawer-toggle",
      attr: { title: "ナビゲーションを開く" },
    });
    
    drawerToggle.createEl("span", {
      cls: "drawer-toggle-icon",
      text: "☰",
    });
  }

  private createDateNavigation(topBarContainer: HTMLElement): void {
    const navContainer = topBarContainer.createEl("div", {
      cls: "date-nav-container compact",
    });
    
    const leftBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: "<",
    });
    
    const calendarBtn = navContainer.createEl("button", {
      cls: "calendar-btn",
      text: "🗓️",
      attr: { title: "カレンダーを開く" },
      style: "font-size:18px;padding:0 6px;background:none;border:none;cursor:pointer;",
    });
    
    const dateLabel = navContainer.createEl("span", { cls: "date-nav-label" });
    
    const rightBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: ">",
    });

    // Update date label
    this.updateDateLabel(dateLabel);
    
    // Event listeners
    leftBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() - 1);
      this.updateDateLabel(dateLabel);
      await this.loadTasks();
      await this.restoreRunningTaskState();
      // Re-apply boundary move when returning to today
      this.checkBoundaryTasks();
    });
    
    rightBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() + 1);
      this.updateDateLabel(dateLabel);
      await this.loadTasks();
      await this.restoreRunningTaskState();
      // Re-apply boundary move when returning to today
      this.checkBoundaryTasks();
    });
    
    // Calendar button functionality
    this.setupCalendarButton(calendarBtn, dateLabel);
    
    // Divider
    topBarContainer.createEl("div", {
      cls: "header-divider",
    });
  }

  private createActionButtons(topBarContainer: HTMLElement): void {
    const actionSection = topBarContainer.createEl("div", {
      cls: "header-action-section",
    });
    
    const addTaskButton = actionSection.createEl("button", {
      cls: "add-task-button repositioned",
      text: "+",
      attr: { title: "新しいタスクを追加" },
    });
    
    const robotButton = actionSection.createEl("button", {
      cls: "robot-terminal-button",
      text: "🤖",
      attr: { title: "ターミナルを開く" },
    });

    // Event listeners
    addTaskButton.addEventListener("click", () => this.showAddTaskModal());
    robotButton.addEventListener("click", async () => {
      try {
        await this.app.commands.executeCommandById(
          "terminal:open-terminal.integrated.root"
        );
      } catch (error) {
        new Notice("ターミナルを開けませんでした: " + error.message);
      }
    });
  }

  private createNavigationUI(contentContainer: HTMLElement): void {
    // Overlay for click outside to close
    this.navigationOverlay = contentContainer.createEl("div", {
      cls: "navigation-overlay navigation-overlay-hidden",
    });

    // Navigation Panel
    this.navigationPanel = contentContainer.createEl("div", {
      cls: "navigation-panel navigation-panel-hidden",
    });

    // Navigation menu
    const navMenu = this.navigationPanel.createEl("nav", {
      cls: "navigation-nav",
    });

    // Navigation items
    const navigationItems = [
      { key: "routine", label: "ルーチン", icon: "🔄" },
      { key: "review", label: "レビュー", icon: "📋" },
      { key: "log", label: "ログ", icon: "📊" },
      { key: "project", label: "プロジェクト", icon: "📁" },
    ];

    navigationItems.forEach((item) => {
      const navItem = navMenu.createEl("div", {
        cls: "navigation-nav-item",
        attr: { "data-section": item.key },
      });
      
      navItem.createEl("span", {
        cls: "navigation-nav-icon",
        text: item.icon,
      });
      
      navItem.createEl("span", {
        cls: "navigation-nav-label",
        text: item.label,
      });

      navItem.addEventListener("click", () => {
        this.handleNavigationItemClick(item.key as any);
      });
    });
  }

  // ===========================================
  // Date Management Methods
  // ===========================================

  private updateDateLabel(label: HTMLElement): void {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const current = new Date(this.currentDate);
    current.setHours(0, 0, 0, 0);
    
    const isToday = current.getTime() === today.getTime();
    const dayName = current.toLocaleDateString('ja-JP', { weekday: 'short' });
    const dateStr = `${this.currentDate.getMonth() + 1}/${this.currentDate.getDate()}`;
    
    // 日付 曜日の順番に変更
    label.textContent = isToday 
      ? `今日 (${dateStr} ${dayName})` 
      : `${dateStr} ${dayName}`;
  }

  private getCurrentDateString(): string {
    const y = this.currentDate.getFullYear();
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
    const d = this.currentDate.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private setupCalendarButton(calendarBtn: HTMLElement, dateLabel: HTMLElement): void {
    calendarBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      
      // Remove existing input if any
      const oldInput = document.getElementById("calendar-date-input");
      if (oldInput) oldInput.remove();
      
      const input = document.createElement("input");
      input.type = "date";
      input.id = "calendar-date-input";
      input.classList.add("taskchute-input-absolute");
      
      // Position the input
      input.style.left = `${calendarBtn.getBoundingClientRect().left}px`;
      input.style.top = `${calendarBtn.getBoundingClientRect().top - 900}px`;
      input.style.zIndex = "10000";
      
      // Set current date
      const y = this.currentDate.getFullYear();
      const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
      const d = this.currentDate.getDate().toString().padStart(2, "0");
      input.value = `${y}-${m}-${d}`;
      
      document.body.appendChild(input);

      // Auto-open calendar
      setTimeout(() => {
        try {
          input.focus();
          input.click();
          
          if (input.showPicker && typeof input.showPicker === "function") {
            input.showPicker();
          } else {
            const mouseEvent = new MouseEvent("mousedown", {
              view: window,
              bubbles: true,
              cancelable: true,
            });
            input.dispatchEvent(mouseEvent);
          }
        } catch (e) {
          // Ignore errors (test environment, etc.)
        }
      }, 50);

      input.addEventListener("change", async () => {
        const [yy, mm, dd] = input.value.split("-").map(Number);
        this.currentDate = new Date(yy, mm - 1, dd);
        this.updateDateLabel(dateLabel);
        await this.loadTasks();
        await this.restoreRunningTaskState();
        // Re-apply boundary move if the selected day is today
        this.checkBoundaryTasks();
        input.remove();
      });
      
      input.addEventListener("blur", () => input.remove());
    });
  }

  // ===========================================
  // Task Loading and Rendering Methods
  // ===========================================

  async loadTasks(): Promise<void> {
    // Use the refactored implementation
    await loadTasksRefactored.call(this);
  }

  private async processTaskFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      
      // Check if it's a task file
      if (!content.includes("#task") && !frontmatter?.estimatedMinutes) {
        return;
      }

      const taskData: TaskData = {
        file,
        frontmatter: frontmatter || {},
        path: file.path,
        name: file.basename,
        project: frontmatter?.project,
        isRoutine: frontmatter?.isRoutine || content.includes("#routine"),
        routine_type: frontmatter?.routine_type,
        routine_start: frontmatter?.routine_start,
        routine_end: frontmatter?.routine_end,
        routine_week: frontmatter?.routine_week,
        routine_day: frontmatter?.routine_day,
        flexible_schedule: frontmatter?.flexible_schedule,
      };

      this.tasks.push(taskData);
    } catch (error) {
      console.error(`Failed to process task file ${file.path}:`, error);
    }
  }

  private async loadTaskInstances(): Promise<void> {
    const dateStr = this.getCurrentDateString();
    
    for (const task of this.tasks) {
      // Check if task should be shown for current date
      if (!this.shouldShowTaskForDate(task, this.currentDate)) {
        continue;
      }

      // Create task instance
      const instance: TaskInstance = {
        task,
        instanceId: this.generateInstanceId(task, dateStr),
        state: 'idle',
        slotKey: this.getTaskSlotKey(task),
        date: dateStr,
      };

      // Check if instance is deleted or hidden
      if (this.isInstanceDeleted(instance.instanceId, task.path, dateStr) ||
          this.isInstanceHidden(instance.instanceId, task.path, dateStr)) {
        continue;
      }

      // Load instance state from localStorage
      this.loadInstanceState(instance, dateStr);
      
      this.taskInstances.push(instance);
    }
  }

  private shouldShowTaskForDate(task: TaskData, date: Date): boolean {
    // Non-routine tasks are always shown (they will be filtered by instance state)
    if (!task.isRoutine) {
      return true;
    }

    // For routine tasks, check schedule
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    
    switch (task.routine_type) {
      case 'daily':
        return true;
      case 'weekdays':
        return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
      case 'weekends':
        return dayOfWeek === 0 || dayOfWeek === 6; // Saturday and Sunday
      case 'weekly':
        // Implement weekly logic based on routine_day
        return true; // Simplified for now
      case 'monthly':
        // Implement monthly logic
        return true; // Simplified for now
      default:
        return true;
    }
  }

  private generateInstanceId(task: TaskData, dateStr: string): string {
    // Generate a unique ID for this task instance
    return `${task.path}_${dateStr}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getTaskSlotKey(task: TaskData): string {
    // Get slot key from localStorage or frontmatter
    const storedSlot = localStorage.getItem(`taskchute-slotkey-${task.path}`);
    if (storedSlot) {
      return storedSlot;
    }

    // Default to "none" (no time specified)
    return "none";
  }

  private loadInstanceState(instance: TaskInstance, dateStr: string): void {
    // Load state from localStorage
    const stateKey = `taskchute-instance-state-${instance.instanceId}`;
    const savedState = localStorage.getItem(stateKey);
    
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        instance.state = parsed.state || 'idle';
        instance.startTime = parsed.startTime ? new Date(parsed.startTime) : undefined;
        instance.stopTime = parsed.stopTime ? new Date(parsed.stopTime) : undefined;
        instance.pausedDuration = parsed.pausedDuration || 0;
        instance.actualMinutes = parsed.actualMinutes;
        instance.comment = parsed.comment;
        instance.focusLevel = parsed.focusLevel;
        instance.energyLevel = parsed.energyLevel;
      } catch (error) {
        console.error("Failed to parse instance state:", error);
      }
    }
  }

  // ===========================================
  // Task Rendering Methods
  // ===========================================

  renderTaskList(): void {
    // Save scroll position
    const scrollTop = this.taskList.scrollTop;
    const scrollLeft = this.taskList.scrollLeft;

    // Apply responsive classes
    this.applyResponsiveClasses();

    this.sortTaskInstancesByTimeOrder();
    this.taskList.empty();
    
    // Group by slot key
    const timeSlots: Record<string, TaskInstance[]> = {};
    this.getTimeSlotKeys().forEach((slot) => {
      timeSlots[slot] = [];
    });
    
    let noTimeInstances: TaskInstance[] = [];
    
    this.taskInstances.forEach((inst) => {
      if (inst.slotKey && inst.slotKey !== "none") {
        // Make sure the slot exists in timeSlots
        if (!timeSlots[inst.slotKey]) {
          timeSlots[inst.slotKey] = [];
        }
        timeSlots[inst.slotKey].push(inst);
      } else {
        noTimeInstances.push(inst);
      }
    });

    // Render "no time specified" group first
    this.renderNoTimeGroup(noTimeInstances);
    
    // Render time slot groups
    this.getTimeSlotKeys().forEach((slot) => {
      const instancesInSlot = timeSlots[slot];
      this.renderTimeSlotGroup(slot, instancesInSlot);
    });

    // Restore scroll position
    this.taskList.scrollTop = scrollTop;
    this.taskList.scrollLeft = scrollLeft;

    // Update totalTasks count
    this.updateTotalTasksCount();
  }

  private renderNoTimeGroup(instances: TaskInstance[]): void {
    const noTimeHeader = this.taskList.createEl("div", {
      cls: "time-slot-header other",
      text: "時間指定なし",
    });

    this.setupTimeSlotDragHandlers(noTimeHeader, "none");
    
    // Sort instances by order before rendering
    const sortedInstances = this.sortByOrder(instances);
    
    sortedInstances.forEach((inst, idx) => {
      this.createTaskInstanceItem(inst, "none", idx);
    });
  }

  private renderTimeSlotGroup(slot: string, instances: TaskInstance[]): void {
    const timeSlotHeader = this.taskList.createEl("div", {
      cls: "time-slot-header",
      text: slot,
    });

    this.setupTimeSlotDragHandlers(timeSlotHeader, slot);
    
    // Sort instances by order before rendering
    const sortedInstances = this.sortByOrder(instances);
    
    sortedInstances.forEach((inst, idx) => {
      this.createTaskInstanceItem(inst, slot, idx);
    });
  }

  private createTaskInstanceItem(inst: TaskInstance, slot: string, idx: number): void {
    const taskItem = this.taskList.createEl("div", { cls: "task-item" });

    // Set data attributes
    if (inst.task.path) {
      taskItem.setAttribute("data-task-path", inst.task.path);
    }
    taskItem.setAttribute("data-slot", slot || "none");

    // Check if future task
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const viewDate = new Date(this.currentDate);
    viewDate.setHours(0, 0, 0, 0);
    const isFutureTask = viewDate > today;

    // Add selection state (disabled to remove background color for running tasks)
    // if (this.currentInstance === inst && inst.state === "running") {
    //   taskItem.classList.add("selected");
    // }

    // Add completion state
    if (inst.state === "done") {
      taskItem.classList.add("completed");
    }

    // 1. Create drag handle (20px)
    this.createDragHandle(taskItem, inst, slot, idx);
    
    // 2. Create play/stop button (40px)
    this.createPlayStopButton(taskItem, inst, isFutureTask);
    
    // 3. Create task name (1fr)
    this.createTaskName(taskItem, inst);
    
    // 4. Create project display (220px)
    this.createProjectDisplay(taskItem, inst);
    
    // 5. Create time range display (110px)
    this.createTimeRangeDisplay(taskItem, inst);
    
    // 6. Create duration/timer display (50px)
    this.createDurationTimerDisplay(taskItem, inst);
    
    // 7. Create comment button (30px)
    this.createCommentButton(taskItem, inst);
    
    // 8. Create routine button (30px)
    this.createRoutineButton(taskItem, inst);
    
    // 9. Create settings button (30px)
    this.createSettingsButton(taskItem, inst);
    
    // Setup event listeners
    this.setupTaskItemEventListeners(taskItem, inst);
  }

  private createDragHandle(taskItem: HTMLElement, inst: TaskInstance, slot: string, idx: number): void {
    const isDraggable = inst.state !== "done";
    
    const dragHandle = taskItem.createEl("div", {
      cls: "drag-handle",
      attr: isDraggable
        ? { draggable: "true", title: "ドラッグして移動" }
        : { title: "完了済みタスク" },
    });

    if (!isDraggable) {
      dragHandle.classList.add("disabled");
    }

    // Create grip icon (6 dots)
    const svg = dragHandle.createSvg("svg", {
      attr: {
        width: "10",
        height: "16",
        viewBox: "0 0 10 16",
        fill: "currentColor",
      },
    });
    
    svg.createSvg("circle", { attr: { cx: "2", cy: "2", r: "1.5" } });
    svg.createSvg("circle", { attr: { cx: "8", cy: "2", r: "1.5" } });
    svg.createSvg("circle", { attr: { cx: "2", cy: "8", r: "1.5" } });
    svg.createSvg("circle", { attr: { cx: "8", cy: "8", r: "1.5" } });
    svg.createSvg("circle", { attr: { cx: "2", cy: "14", r: "1.5" } });
    svg.createSvg("circle", { attr: { cx: "8", cy: "14", r: "1.5" } });

    // Setup drag events
    if (isDraggable) {
      this.setupDragEvents(dragHandle, taskItem, slot, idx);
    }

    // Click handler for selection
    dragHandle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectTaskForKeyboard(inst, taskItem);
    });
  }

  private createPlayStopButton(taskItem: HTMLElement, inst: TaskInstance, isFutureTask: boolean): void {
    let btnCls = "play-stop-button";
    let btnText = "▶️";
    let btnTitle = "スタート";
    
    if (isFutureTask) {
      btnCls += " future-task-button";
      btnText = "—";
      btnTitle = "未来のタスクは実行できません";
    } else if (inst.state === "running") {
      btnCls += " stop";
      btnText = "⏹";
      btnTitle = "ストップ";
    } else if (inst.state === "done") {
      btnText = "☑️";
      btnTitle = "完了タスクを再計測";
    }

    const playButton = taskItem.createEl("button", {
      cls: btnCls,
      text: btnText,
      attr: { title: btnTitle },
    });

    if (isFutureTask) {
      playButton.disabled = true;
    }

    playButton.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (isFutureTask) {
        new Notice("未来のタスクは実行できません。", 2000);
        return;
      }
      
      if (inst.state === "running") {
        await this.stopInstance(inst);
      } else if (inst.state === "idle") {
        await this.startInstance(inst);
      } else if (inst.state === "done") {
        // Replay functionality for completed tasks
        await this.duplicateAndStartInstance(inst);
      }
    });
  }

  private createTaskName(taskItem: HTMLElement, inst: TaskInstance): void {
    const taskName = taskItem.createEl("span", {
      cls: "task-name",
      text: inst.task.name,
    });

    // Apply same style for all tasks (completed and non-completed)
    taskName.style.color = "var(--text-accent)";

    // Click handler to open task file
    taskName.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await this.app.workspace.openLinkText(inst.task.path, "", false);
      } catch (error) {
        new Notice("タスクファイルを開けませんでした");
      }
    });
  }

  private createProjectDisplay(taskItem: HTMLElement, inst: TaskInstance): void {
    const projectDisplay = taskItem.createEl("span", {
      cls: "taskchute-project-display",
    });

    if (inst.task.projectPath && inst.task.projectTitle) {
      // Project button with folder icon and name
      const projectButton = projectDisplay.createEl("span", {
        cls: "taskchute-project-button",
        attr: {
          title: `プロジェクト: ${inst.task.projectTitle}`,
        },
      });

      // Folder icon
      const folderIcon = projectButton.createEl("span", {
        cls: "taskchute-project-icon",
        text: "📁",
      });

      // Project name (remove "Project - " prefix)
      const projectName = projectButton.createEl("span", {
        cls: "taskchute-project-name",
        text: inst.task.projectTitle.replace(/^Project\s*-\s*/, ""),
      });

      // Click handler for project
      projectButton.addEventListener("click", async (e) => {
        e.stopPropagation();
        // Open project file or show project modal
        await this.showUnifiedProjectModal(inst);
      });

      // External link icon
      const externalLinkIcon = projectDisplay.createEl("span", {
        cls: "taskchute-external-link",
        text: "🔗",
        attr: { title: "プロジェクトノートを開く" },
      });

      externalLinkIcon.addEventListener("click", async (e) => {
        e.stopPropagation();
        // Open project file directly
        await this.openProjectInSplit(inst.task.projectPath);
      });
    } else {
      // プロジェクト未設定の場合（ホバーで表示）
      const projectPlaceholder = projectDisplay.createEl("span", {
        cls: "taskchute-project-placeholder",
        attr: { title: "クリックしてプロジェクトを設定" },
      });
      
      projectPlaceholder.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.showProjectModal(inst);
      });
    }
  }

  private createTimeRangeDisplay(taskItem: HTMLElement, inst: TaskInstance): void {
    const timeRangeEl = taskItem.createEl("span", {
      cls: "task-time-range",
    });

    const formatTime = (date: Date) =>
      date ? date.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      }) : "";

    if (inst.state === "running" && inst.startTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} →`;
    } else if (inst.state === "done" && inst.startTime && inst.stopTime) {
      timeRangeEl.textContent = `${formatTime(inst.startTime)} → ${formatTime(inst.stopTime)}`;
    } else {
      timeRangeEl.textContent = "";
    }
  }

  private createDurationTimerDisplay(taskItem: HTMLElement, inst: TaskInstance): void {
    if (inst.state === "done" && inst.startTime && inst.stopTime) {
      // Completed task: show duration
      const durationEl = taskItem.createEl("span", {
        cls: "task-duration",
      });

      const duration = this.calculateCrossDayDuration(inst.startTime, inst.stopTime);
      const hours = Math.floor(duration / 3600000);
      const minutes = Math.floor((duration % 3600000) / 60000) % 60;
      const durationStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
      
      durationEl.textContent = durationStr;

      // Add tooltip for cross-day tasks
      if (inst.startTime.getDate() !== inst.stopTime.getDate()) {
        durationEl.setAttribute("title", "日を跨いだタスク");
      }
    } else if (inst.state === "running") {
      // Running task: show timer
      const timerEl = taskItem.createEl("span", {
        cls: "task-timer-display",
      });
      this.updateTimerDisplay(timerEl, inst);
    } else {
      // Idle task: show placeholder
      taskItem.createEl("span", {
        cls: "task-duration-placeholder",
      });
    }
  }

  private createCommentButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const commentButton = taskItem.createEl("button", {
      cls: "comment-button",
      text: "💬",
      attr: {
        "data-task-state": inst.state,
      },
    });

    // Enable only for completed tasks
    if (inst.state !== "done") {
      commentButton.classList.add("disabled");
      commentButton.setAttribute("disabled", "true");
    }

    commentButton.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (inst.state !== "done") {
        return;
      }
      // Show comment modal for completed tasks
      await this.showTaskCompletionModal(inst);
    });

    // Update comment state based on existing comments
    this.hasCommentData(inst).then((hasComment) => {
      if (hasComment) {
        commentButton.classList.add("active");
      } else {
        commentButton.classList.remove("active");
        if (inst.state === "done") {
          commentButton.classList.add("no-comment");
        }
      }
    });
  }

  private createRoutineButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const routineButton = taskItem.createEl("button", {
      cls: `routine-button ${inst.task.isRoutine ? "active" : ""}`,
      text: "🔄",
      attr: {
        title: inst.task.isRoutine
          ? `ルーチンタスク`
          : "ルーチンタスクに設定",
      },
    });

    routineButton.addEventListener("click", (e) => {
      e.stopPropagation();
      if (inst.task.isRoutine) {
        this.showRoutineEditModal(inst.task, routineButton);
      } else {
        this.toggleRoutine(inst.task, routineButton);
      }
    });
  }

  private createSettingsButton(taskItem: HTMLElement, inst: TaskInstance): void {
    const settingsButton = taskItem.createEl("button", {
      cls: "settings-task-button",
      text: "⚙️",
      attr: { title: "タスク設定" },
    });

    settingsButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showTaskSettingsTooltip(inst, settingsButton);
    });
  }

  // ===========================================
  // Missing Method Placeholders
  // ===========================================

  private async duplicateAndStartInstance(inst: TaskInstance): Promise<void> {
    await this.duplicateInstance(inst);
  }
  
  private async duplicateInstance(inst: TaskInstance): Promise<void> {
    try {
      // 新しいインスタンスを作成
      const newInstance: TaskInstance = {
        ...inst,
        instanceId: this.generateInstanceId(inst.task.path),
        state: "idle",
        startTime: undefined,
        stopTime: undefined,
      };
      
      // インスタンスリストに追加
      this.taskInstances.push(newInstance);
      
      // 状態を保存
      this.saveInstanceState(newInstance);
      
      // UIを更新
      this.renderTaskList();
      
      new Notice(`「${inst.task.title}」を複製しました`);
    } catch (error) {
      console.error("Failed to duplicate instance:", error);
      new Notice("タスクの複製に失敗しました");
    }
  }

  private async showTaskCompletionModal(inst: TaskInstance): Promise<void> {
    const existingComment = await this.getExistingTaskComment(inst);
    const modal = document.createElement("div");
    modal.className = "taskchute-comment-modal";
    const modalContent = modal.createEl("div", {
      cls: "taskchute-comment-content"
    });
    
    // ヘッダー
    const header = modalContent.createEl("div", { cls: "taskchute-modal-header" });
    const headerText = existingComment
      ? `✏️ 「${inst.task.title}」のコメントを編集`
      : `🎉 お疲れ様でした！「${inst.task.title}」が完了しました`;
    header.createEl("h2", { text: headerText });
    
    // 実行時間表示（完了タスクのみ）
    if (inst.state === "done" && inst.actualTime) {
      const timeInfo = modalContent.createEl("div", { cls: "taskchute-time-info" });
      const duration = this.formatTime(inst.actualTime);
      const startTime = inst.startTime ? new Date(inst.startTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
      const endTime = inst.stopTime ? new Date(inst.stopTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
      
      timeInfo.createEl("div", { 
        text: `実行時間: ${duration}`,
        cls: "time-duration"
      });
      if (startTime && endTime) {
        timeInfo.createEl("div", { 
          text: `開始: ${startTime} 終了: ${endTime}`,
          cls: "time-range"
        });
      }
    }
    
    // 評価セクション
    const ratingSection = modalContent.createEl("div", { cls: "taskchute-rating-section" });
    ratingSection.createEl("h3", { text: "今回のタスクはいかがでしたか？" });
    
    // 集中度
    const focusGroup = ratingSection.createEl("div", { cls: "rating-group" });
    focusGroup.createEl("label", { text: "集中度:", cls: "rating-label" });
    const initialFocusRating = existingComment?.focusLevel || 0;
    const focusRating = focusGroup.createEl("div", { 
      cls: "star-rating", 
      attr: { "data-rating": initialFocusRating.toString() } 
    });
    for (let i = 1; i <= 5; i++) {
      const star = focusRating.createEl("span", { 
        cls: `star ${i <= initialFocusRating ? 'taskchute-star-filled' : 'taskchute-star-empty'}`,
        text: "⭐"
      });
      star.addEventListener("click", () => {
        this.setRating(focusRating, i);
      });
      star.addEventListener("mouseenter", () => {
        this.highlightRating(focusRating, i);
      });
      star.addEventListener("mouseleave", () => {
        this.resetRatingHighlight(focusRating);
      });
    }
    // 初期値を表示に反映
    this.updateRatingDisplay(focusRating, initialFocusRating);
    
    // 元気度  
    const energyGroup = ratingSection.createEl("div", { cls: "rating-group" });
    energyGroup.createEl("label", { text: "元気度:", cls: "rating-label" });
    const initialEnergyRating = existingComment?.energyLevel || 0;
    const energyRating = energyGroup.createEl("div", { 
      cls: "star-rating", 
      attr: { "data-rating": initialEnergyRating.toString() } 
    });
    for (let i = 1; i <= 5; i++) {
      const star = energyRating.createEl("span", { 
        cls: `star ${i <= initialEnergyRating ? 'taskchute-star-filled' : 'taskchute-star-empty'}`,
        text: "⭐"
      });
      star.addEventListener("click", () => {
        this.setRating(energyRating, i);
      });
      star.addEventListener("mouseenter", () => {
        this.highlightRating(energyRating, i);
      });
      star.addEventListener("mouseleave", () => {
        this.resetRatingHighlight(energyRating);
      });
    }
    // 初期値を表示に反映
    this.updateRatingDisplay(energyRating, initialEnergyRating);
    
    // コメント入力エリア
    const commentSection = modalContent.createEl("div", { cls: "taskchute-comment-section" });
    commentSection.createEl("label", { text: "感想・学び・次回への改善点:", cls: "comment-label" });
    const commentInput = commentSection.createEl("textarea", {
      cls: "taskchute-comment-textarea",
      placeholder: "今回のタスクで感じたこと、学んだこと、次回への改善点などを自由にお書きください..."
    });
    // ⚠️ 重要：valueプロパティに直接代入（steering documentの指示通り）
    if (existingComment?.executionComment) {
      (commentInput as HTMLTextAreaElement).value = existingComment.executionComment;
    }
    
    // アクションボタン
    const buttonGroup = modalContent.createEl("div", { cls: "taskchute-comment-actions" });
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "taskchute-button-cancel",
      text: "キャンセル"
    });
    const saveButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "taskchute-button-save",
      text: "保存"
    });
    
    // イベントハンドラ
    const closeModal = () => {
      document.body.removeChild(modal);
    };
    
    // ESCキーでモーダルを閉じる
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeModal();
        document.removeEventListener("keydown", handleEsc);
      }
    };
    document.addEventListener("keydown", handleEsc);
    
    // モーダル外クリックで閉じる
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
    
    cancelButton.addEventListener("click", closeModal);
    
    saveButton.addEventListener("click", async () => {
      const focusValue = parseInt(focusRating.getAttribute("data-rating") || "0");
      const energyValue = parseInt(energyRating.getAttribute("data-rating") || "0");
      
      await this.saveTaskComment(inst, {
        comment: (commentInput as HTMLTextAreaElement).value,
        energy: energyValue,
        focus: focusValue,
        focusLevel: focusValue,  // 新形式との互換性
        energyLevel: energyValue, // 新形式との互換性
        executionComment: (commentInput as HTMLTextAreaElement).value, // 新形式との互換性
        timestamp: new Date().toISOString()
      } as any);
      closeModal();
      this.renderTaskList();
    });
    
    document.body.appendChild(modal);
    commentInput.focus();
  }
  
  // 星評価ヘルパー関数
  private setRating(ratingEl: HTMLElement, value: number): void {
    ratingEl.setAttribute("data-rating", value.toString());
    this.updateRatingDisplay(ratingEl, value);
  }
  
  private highlightRating(ratingEl: HTMLElement, value: number): void {
    this.updateRatingDisplay(ratingEl, value);
  }
  
  private resetRatingHighlight(ratingEl: HTMLElement): void {
    const currentRating = parseInt(ratingEl.getAttribute("data-rating") || "0");
    this.updateRatingDisplay(ratingEl, currentRating);
  }
  
  private updateRatingDisplay(ratingEl: HTMLElement, value: number): void {
    const stars = ratingEl.querySelectorAll(".star");
    stars.forEach((star, index) => {
      if (index < value) {
        star.classList.add("taskchute-star-filled");
        star.classList.remove("taskchute-star-empty");
      } else {
        star.classList.add("taskchute-star-empty");
        star.classList.remove("taskchute-star-filled");
      }
    });
  }
  
  // 10段階を5段階に変換
  private convertToFiveScale(value: number): number {
    if (value === 0) return 0;
    if (value > 5) return Math.ceil(value / 2);
    return value;
  }

  private async hasCommentData(inst: TaskInstance): Promise<boolean> {
    try {
      const existingComment = await this.getExistingTaskComment(inst);
      if (!existingComment) {
        return false;
      }

      return (
        (existingComment.executionComment && 
          existingComment.executionComment.trim().length > 0) ||
        existingComment.focusLevel > 0 ||
        existingComment.energyLevel > 0
      );
    } catch (error) {
      return false;
    }
  }
  
  private async getExistingTaskComment(inst: TaskInstance): Promise<any> {
    try {
      // instanceIdが存在しない場合は、コメントなしとして扱う
      if (!inst.instanceId) {
        return null;
      }

      // 月次ログファイルのパス生成
      const currentDate = this.currentDate;
      const year = currentDate.getFullYear();
      const month = (currentDate.getMonth() + 1).toString().padStart(2, "0");
      const day = currentDate.getDate().toString().padStart(2, "0");
      const monthString = `${year}-${month}`;
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`;

      // JSONファイルを読み込み
      const logFile = this.app.vault.getAbstractFileByPath(logFilePath);
      if (!logFile || !(logFile instanceof TFile)) {
        return null;
      }

      const logContent = await this.app.vault.read(logFile);
      const monthlyLog = JSON.parse(logContent);

      // 該当日付のタスク実行ログから検索
      const dateString = `${year}-${month}-${day}`;
      const todayTasks = monthlyLog.taskExecutions?.[dateString] || [];
      
      // instanceIdが一致するエントリを検索
      const existingEntry = todayTasks.find(
        (entry: any) => entry.instanceId === inst.instanceId
      );

      return existingEntry || null;
    } catch (error) {
      return null;
    }
  }
  
  private async saveTaskComment(inst: TaskInstance, data: { comment: string; energy: number; focus: number }): Promise<void> {
    try {
      // instanceIdが存在しない場合はエラー
      if (!inst.instanceId) {
        throw new Error("instanceId is required");
      }

      // 月次ログファイルのパス生成
      const currentDate = this.currentDate;
      const year = currentDate.getFullYear();
      const month = (currentDate.getMonth() + 1).toString().padStart(2, "0");
      const day = currentDate.getDate().toString().padStart(2, "0");
      const monthString = `${year}-${month}`;
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`;
      const dateString = `${year}-${month}-${day}`;

      // JSONファイルを読み込み（存在しない場合は新規作成）
      const logFile = this.app.vault.getAbstractFileByPath(logFilePath);
      let monthlyLog: any = { taskExecutions: {} };
      
      if (logFile && logFile instanceof TFile) {
        const logContent = await this.app.vault.read(logFile);
        monthlyLog = JSON.parse(logContent);
      }

      // 該当日付のタスク実行ログを取得または初期化
      if (!monthlyLog.taskExecutions) {
        monthlyLog.taskExecutions = {};
      }
      if (!monthlyLog.taskExecutions[dateString]) {
        monthlyLog.taskExecutions[dateString] = [];
      }

      const todayTasks = monthlyLog.taskExecutions[dateString];
      
      // instanceIdが一致するエントリを検索
      const existingIndex = todayTasks.findIndex(
        (entry: any) => entry.instanceId === inst.instanceId
      );
      const existingTaskData = existingIndex >= 0 ? { ...todayTasks[existingIndex] } : null;

      // コメントデータの構造を仕様に合わせる（JSON安全な最小構造）
      const pad = (n: number) => String(n).padStart(2, '0')
      const toHMS = (d?: Date) => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : ''
      const durationSec = (inst.startTime && inst.stopTime)
        ? Math.floor(this.calculateCrossDayDuration(inst.startTime, inst.stopTime) / 1000)
        : 0

      const commentData = {
        instanceId: inst.instanceId,
        taskPath: inst.task?.path || '',
        taskName: inst.task?.name || '',
        startTime: toHMS(inst.startTime),
        stopTime: toHMS(inst.stopTime),
        duration: durationSec,
        executionComment: (data.comment || '').trim(),
        focusLevel: data.focus || 0,
        energyLevel: data.energy || 0,
        isCompleted: inst.state === 'done',
        project_path: inst.task?.projectPath || null,
        project: inst.task?.projectTitle ? `[[${inst.task.projectTitle}]]` : null,
        timestamp: new Date().toISOString(),
      } as any;

      if (existingIndex >= 0) {
        // 既存エントリを更新
        todayTasks[existingIndex] = {
          ...todayTasks[existingIndex],
          // 変化しうるフィールドのみ更新
          executionComment: commentData.executionComment,
          focusLevel: commentData.focusLevel,
          energyLevel: commentData.energyLevel,
          startTime: commentData.startTime || todayTasks[existingIndex].startTime,
          stopTime: commentData.stopTime || todayTasks[existingIndex].stopTime,
          duration: durationSec || todayTasks[existingIndex].duration,
          isCompleted: commentData.isCompleted,
          project_path: commentData.project_path ?? todayTasks[existingIndex].project_path,
          project: commentData.project ?? todayTasks[existingIndex].project,
          lastCommentUpdate: new Date().toISOString(),
          timestamp: commentData.timestamp,
        };
      } else {
        // 新規エントリを追加
        todayTasks.push(commentData);
      }

      // JSONファイルに保存
      if (logFile && logFile instanceof TFile) {
        await this.app.vault.modify(logFile, JSON.stringify(monthlyLog, null, 2));
      } else {
        await this.app.vault.create(logFilePath, JSON.stringify(monthlyLog, null, 2));
      }

      // プロジェクトノートへの同期（コメント本文が変更された場合のみ）
      const completionData = {
        executionComment: (data.comment || '').trim(),
        focusLevel: data.focus,
        energyLevel: data.energy,
      } as any

      if (
        completionData.executionComment &&
        (inst.task.projectPath || inst.task.projectTitle) &&
        this.hasCommentChanged(existingTaskData, completionData)
      ) {
        await this.syncCommentToProjectNote(inst, completionData)
      }
      
      new Notice("コメントを保存しました");
    } catch (error) {
      console.error("Failed to save comment:", error);
      new Notice("コメントの保存に失敗しました");
    }
  }

  // コメント本文の変更検出
  private hasCommentChanged(oldData: any, newData: { executionComment?: string } | null | undefined): boolean {
    const oldComment = (oldData?.executionComment ?? '') as string
    const newComment = (newData?.executionComment ?? '') as string
    return oldComment !== newComment
  }

  // プロジェクトノートにコメントを同期
  private async syncCommentToProjectNote(inst: TaskInstance, completionData: { executionComment: string }): Promise<void> {
    try {
      const syncManager = new ProjectNoteSyncManager(this.app, this.plugin.pathManager)
      const projectPath = await syncManager.getProjectNotePath(inst)
      if (!projectPath) return
      await syncManager.updateProjectNote(projectPath, inst, completionData)
    } catch (error: any) {
      new Notice(`プロジェクトノートの更新に失敗しました: ${error.message || error}`)
    }
  }

  private showRoutineEditModal(task: any, button: HTMLElement): void {
    // モーダルコンテナ
    const modal = document.createElement("div");
    modal.className = "task-modal-overlay";
    const modalContent = modal.createEl("div", { cls: "task-modal-content" });
    
    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
    modalHeader.createEl("h3", { text: `「${task.title}」のルーチン設定` });
    
    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    });
    
    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" });
    
    // ルーチンタイプ選択
    const typeGroup = form.createEl("div", { cls: "form-group" });
    typeGroup.createEl("label", { text: "ルーチンタイプ:", cls: "form-label" });
    const typeSelect = typeGroup.createEl("select", {
      cls: "form-input",
    }) as HTMLSelectElement;
    
    // オプション追加
    const options = [
      { value: "daily", text: "毎日" },
      { value: "weekdays", text: "平日のみ" },
      { value: "weekends", text: "週末のみ" },
      { value: "weekly", text: "週次（曜日指定）" },
      { value: "monthly", text: "月次（第X週のX曜日）" },
    ];
    
    options.forEach(opt => {
      const option = typeSelect.createEl("option", {
        value: opt.value,
        text: opt.text,
      });
      if (task.routine_type === opt.value) {
        option.selected = true;
      }
    });
    
    // 現在のルーチンタイプまたはデフォルト
    if (!task.routine_type) {
      typeSelect.value = "daily";
    }
    
    // 開始時刻入力
    const timeGroup = form.createEl("div", { cls: "form-group" });
    timeGroup.createEl("label", { text: "開始予定時刻:", cls: "form-label" });
    const timeInput = timeGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: task.scheduledTime || "09:00",
    }) as HTMLInputElement;
    
    // 週次設定グループ（初期非表示）
    const weeklyGroup = form.createEl("div", { 
      cls: "form-group",
      style: "display: none;"
    });
    weeklyGroup.createEl("label", { text: "曜日を選択:", cls: "form-label" });
    const weekdayContainer = weeklyGroup.createEl("div", { cls: "weekday-checkboxes" });
    
    const weekdays = [
      { value: 0, label: "日" },
      { value: 1, label: "月" },
      { value: 2, label: "火" },
      { value: 3, label: "水" },
      { value: 4, label: "木" },
      { value: 5, label: "金" },
      { value: 6, label: "土" },
    ];
    
    const weekdayCheckboxes: HTMLInputElement[] = [];
    weekdays.forEach(day => {
      const label = weekdayContainer.createEl("label", { 
        cls: "weekday-checkbox-label" 
      });
      const checkbox = label.createEl("input", {
        type: "checkbox",
        value: day.value.toString(),
      }) as HTMLInputElement;
      weekdayCheckboxes.push(checkbox);
      
      // 既存の設定を反映
      if (task.weekdays && Array.isArray(task.weekdays)) {
        checkbox.checked = task.weekdays.includes(day.value);
      }
      
      label.createEl("span", { text: day.label });
    });
    
    // 月次設定グループ（初期非表示）
    const monthlyGroup = form.createEl("div", { 
      cls: "form-group",
      style: "display: none;"
    });
    monthlyGroup.createEl("label", { text: "月次設定:", cls: "form-label" });
    
    const monthlyContainer = monthlyGroup.createEl("div", { 
      cls: "monthly-settings",
      style: "display: flex; gap: 10px; align-items: center;"
    });
    
    monthlyContainer.createEl("span", { text: "第" });
    const weekSelect = monthlyContainer.createEl("select", {
      cls: "form-input",
      style: "width: 60px;"
    }) as HTMLSelectElement;
    
    for (let i = 1; i <= 5; i++) {
      const option = weekSelect.createEl("option", {
        value: (i - 1).toString(),
        text: i.toString(),
      });
      if (task.monthly_week === i - 1) {
        option.selected = true;
      }
    }
    
    monthlyContainer.createEl("span", { text: "週の" });
    const monthlyWeekdaySelect = monthlyContainer.createEl("select", {
      cls: "form-input",
      style: "width: 80px;"
    }) as HTMLSelectElement;
    
    weekdays.forEach(day => {
      const option = monthlyWeekdaySelect.createEl("option", {
        value: day.value.toString(),
        text: day.label + "曜日",
      });
      if (task.monthly_weekday === day.value) {
        option.selected = true;
      }
    });
    
    // タイプ変更時の表示切り替え
    typeSelect.addEventListener("change", () => {
      const selectedType = typeSelect.value;
      
      // 全て非表示にする
      weeklyGroup.style.display = "none";
      monthlyGroup.style.display = "none";
      
      // 選択に応じて表示
      if (selectedType === "weekly") {
        weeklyGroup.style.display = "block";
      } else if (selectedType === "monthly") {
        monthlyGroup.style.display = "block";
      }
    });
    
    // 初期表示設定
    if (task.routine_type === "weekly") {
      weeklyGroup.style.display = "block";
    } else if (task.routine_type === "monthly") {
      monthlyGroup.style.display = "block";
    }
    
    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" });
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    });
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    });
    
    // 既存のルーチンタスクの場合のみ「ルーチンを外す」ボタンを表示
    let removeButton: HTMLButtonElement | null = null;
    if (task.isRoutine) {
      removeButton = buttonGroup.createEl("button", {
        type: "button",
        cls: "form-button cancel",
        text: "ルーチンを外す",
      }) as HTMLButtonElement;
    }
    
    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    
    if (removeButton) {
      removeButton.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.toggleRoutine(task, button);
        if (modal.parentNode) document.body.removeChild(modal);
      });
    }
    
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const scheduledTime = timeInput.value;
      const routineType = typeSelect.value;
      
      if (!scheduledTime) {
        new Notice("開始時刻を入力してください");
        return;
      }
      
      // 週次の場合、曜日が選択されているか確認
      if (routineType === "weekly") {
        const selectedWeekdays = weekdayCheckboxes
          .filter(cb => cb.checked)
          .map(cb => parseInt(cb.value));
        
        if (selectedWeekdays.length === 0) {
          new Notice("曜日を選択してください");
          return;
        }
      }
      
      // ルーチンタスクとして設定
      await this.setRoutineTaskWithDetails(
        task, 
        button, 
        scheduledTime, 
        routineType,
        {
          weekdays: routineType === "weekly" 
            ? weekdayCheckboxes.filter(cb => cb.checked).map(cb => parseInt(cb.value))
            : undefined,
          monthly_week: routineType === "monthly" 
            ? parseInt(weekSelect.value)
            : undefined,
          monthly_weekday: routineType === "monthly"
            ? parseInt(monthlyWeekdaySelect.value)
            : undefined,
        }
      );
      
      document.body.removeChild(modal);
    });
    
    // モーダルを表示
    document.body.appendChild(modal);
    timeInput.focus();
  }

  private async toggleRoutine(task: any, button: HTMLElement): Promise<void> {
    try {
      // タスク名からファイルを探す
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
      const filePath = `${taskFolderPath}/${task.title}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (!file || !(file instanceof TFile)) {
        new Notice(`タスクファイル「${task.title}.md」が見つかりません`);
        return;
      }
      
      if (task.isRoutine) {
        // ルーチンタスクを解除
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const y = this.currentDate.getFullYear();
          const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
          const d = this.currentDate.getDate().toString().padStart(2, "0");
          frontmatter.routine_end = `${y}-${m}-${d}`;
          frontmatter.isRoutine = false;
          delete frontmatter.開始時刻;
          return frontmatter;
        });
        
        // 状態リセット
        task.isRoutine = false;
        task.scheduledTime = null;
        button.classList.remove("active");
        button.setAttribute("title", "ルーチンタスクに設定");
        
        // タスク情報を再取得し、UIを最新化
        await this.loadTasks();
        new Notice(`「${task.title}」をルーチンタスクから解除しました`);
      } else {
        // ルーチンタスクに設定（時刻入力ポップアップを表示）
        this.showRoutineEditModal(task, button);
      }
    } catch (error) {
      new Notice("ルーチンタスクの設定に失敗しました");
    }
  }

  private showTaskSettingsTooltip(inst: TaskInstance, button: HTMLElement): void {
    // 既存のツールチップを削除
    const existingTooltip = document.querySelector(".task-settings-tooltip");
    if (existingTooltip) {
      existingTooltip.remove();
    }
    
    // ツールチップコンテナを作成
    const tooltip = document.createElement("div");
    tooltip.className = "task-settings-tooltip";
    
    // ヘッダー部分（バツボタン用）
    const tooltipHeader = tooltip.createEl("div", {
      cls: "tooltip-header",
    });
    
    // バツボタンを追加
    const closeButton = tooltipHeader.createEl("button", {
      cls: "tooltip-close-button",
      text: "×",
      attr: { title: "閉じる" },
    });
    closeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      tooltip.remove();
    });
    
    // 「未実行に戻す」項目を追加
    const resetItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "↩️ 未実行に戻す",
    });
    if (inst.state === "idle") {
      resetItem.classList.add("disabled");
      resetItem.setAttribute("title", "このタスクは未実行です");
    } else {
      resetItem.setAttribute("title", "タスクを実行前の状態に戻します");
    }
    resetItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      tooltip.remove();
      if (inst.state !== "idle") {
        await this.resetTaskToIdle(inst);
      }
    });
    
    // 「タスクを移動」項目を追加
    const moveItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "📅 タスクを移動",
    });
    moveItem.setAttribute("title", "タスクを別の日付に移動します");
    moveItem.addEventListener("click", (e) => {
      e.stopPropagation();
      tooltip.remove();
      this.showTaskMoveDatePicker(inst, button);
    });
    
    // 「タスクを複製」項目を追加
    const duplicateItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "📄 タスクを複製",
    });
    duplicateItem.setAttribute("title", "同じタスクをすぐ下に追加します");
    duplicateItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      tooltip.remove();
      await this.duplicateInstance(inst);
    });
    
    // 削除項目を追加
    const deleteItem = tooltip.createEl("div", {
      cls: "tooltip-item delete-item",
      text: "🗑️ タスクを削除",
    });
    deleteItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      tooltip.remove();
      // 履歴の存在で判定
      const hasHistory = await this.hasExecutionHistory(inst.task.path);
      // 統一された削除処理を使用
      if (inst.task.isRoutine || hasHistory) {
        await this.deleteRoutineTask(inst);
      } else {
        await this.deleteNonRoutineTask(inst);
      }
    });
    
    // ボタンの位置を取得してツールチップを配置
    const buttonRect = button.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    const tooltipHeight = 250; // 推定されるツールチップの高さ
    const tooltipWidth = 200; // 推定されるツールチップの幅
    
    tooltip.style.position = "fixed"; // absoluteからfixedに変更
    tooltip.style.zIndex = "10000";
    
    // 画面下部に近い場合は上向きに表示
    if (buttonRect.bottom + tooltipHeight > windowHeight) {
      tooltip.style.bottom = `${windowHeight - buttonRect.top + 5}px`;
      tooltip.style.top = "auto";
    } else {
      tooltip.style.top = `${buttonRect.bottom + 5}px`;
      tooltip.style.bottom = "auto";
    }
    
    // 画面右端に近い場合は左寄せ
    if (buttonRect.left + tooltipWidth > windowWidth) {
      tooltip.style.right = `${windowWidth - buttonRect.right}px`;
      tooltip.style.left = "auto";
    } else {
      tooltip.style.left = `${buttonRect.left}px`;
      tooltip.style.right = "auto";
    }
    
    // 最小幅を設定
    tooltip.style.minWidth = "180px";
    tooltip.style.maxWidth = "250px";
    
    // ドキュメントに追加
    document.body.appendChild(tooltip);
    
    // クリック外で閉じる
    const closeTooltip = (e: MouseEvent) => {
      if (!tooltip.contains(e.target as Node) && e.target !== button) {
        tooltip.remove();
        document.removeEventListener("click", closeTooltip);
      }
    };
    
    setTimeout(() => {
      document.addEventListener("click", closeTooltip);
    }, 100);
  }

  // ===========================================
  // Task State Management Methods
  // ===========================================

  async startInstance(inst: TaskInstance): Promise<void> {
    try {
      // Stop current instance if any
      if (this.currentInstance && this.currentInstance.state === "running") {
        await this.stopInstance(this.currentInstance);
      }

      // Start the new instance
      inst.state = "running";
      inst.startTime = new Date();
      this.currentInstance = inst;

      // Save state
      this.saveInstanceState(inst);
      
      // Save running task state for persistence
      await this.saveRunningTasksState();
      
      // Update UI
      this.renderTaskList();
      
      // Start global timer if not running
      if (!this.globalTimerInterval) {
        this.startGlobalTimer();
      }

      new Notice(`開始: ${inst.task.name}`);
    } catch (error) {
      console.error("Failed to start instance:", error);
      new Notice("タスクの開始に失敗しました");
    }
  }

  async stopInstance(inst: TaskInstance): Promise<void> {
    try {
      if (inst.state !== "running") {
        return;
      }

      inst.state = "done";
      inst.stopTime = new Date();
      
      if (inst.startTime) {
        const duration = this.calculateCrossDayDuration(inst.startTime, inst.stopTime);
        inst.actualMinutes = Math.floor(duration / (1000 * 60));
      }

      // Clear current instance if this is it
      if (this.currentInstance === inst) {
        this.currentInstance = null;
      }

      // Save state
      this.saveInstanceState(inst);
      
      // Save to log
      await this.saveTaskLog(inst);
      
      // Save running task state (remove this task from running tasks)
      await this.saveRunningTasksState();
      
      // Update yearly heatmap stats (start date basis)
      try {
        const start = inst.startTime || new Date();
        const yyyy = start.getFullYear();
        const mm = String(start.getMonth() + 1).padStart(2, '0');
        const dd = String(start.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        const heatmap = new HeatmapService(this.plugin as any);
        await heatmap.updateDailyStats(dateStr);
      } catch (_) {}
      
      // CRITICAL: Recalculate task orders to maintain execution time order
      // This ensures completed tasks are sorted by startTime immediately
      this.initializeTaskOrders();
      
      // Update UI
      this.renderTaskList();

      new Notice(`完了: ${inst.task.name} (${inst.actualMinutes || 0}分)`);
    } catch (error) {
      console.error("Failed to stop instance:", error);
      new Notice("タスクの停止に失敗しました");
    }
  }

  private calculateCrossDayDuration(startTime: Date, stopTime: Date): number {
    if (!startTime || !stopTime) return 0;

    let duration = stopTime.getTime() - startTime.getTime();

    // If negative, it's a cross-day task
    if (duration < 0) {
      duration += 24 * 60 * 60 * 1000;
    }

    return duration;
  }

  // ===========================================
  // Running Task Persistence Methods
  // ===========================================

  async saveRunningTasksState(): Promise<void> {
    try {
      const runningInstances = this.taskInstances.filter(
        (inst) => inst.state === "running"
      );

      const dataToSave = runningInstances.map((inst) => {
        const today = inst.startTime ? new Date(inst.startTime) : new Date();
        const y = today.getFullYear();
        const m = (today.getMonth() + 1).toString().padStart(2, "0");
        const d = today.getDate().toString().padStart(2, "0");
        const dateString = `${y}-${m}-${d}`;

        return {
          date: dateString,
          taskTitle: inst.task.name,
          taskPath: inst.task.path,
          startTime: inst.startTime ? inst.startTime.toISOString() : new Date().toISOString(),
          slotKey: inst.slotKey,
          instanceId: inst.instanceId,
          taskDescription: inst.task.description || "",
          isRoutine: inst.task.isRoutine === true
        };
      });

      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const dataPath = `${logDataPath}/running-task.json`;
      
      await this.app.vault.adapter.write(dataPath, JSON.stringify(dataToSave, null, 2));
    } catch (e) {
      console.error("[TaskChute] 実行中タスクの保存に失敗:", e);
    }
  }

  async restoreRunningTaskState(): Promise<void> {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const dataPath = `${logDataPath}/running-task.json`;
      const dataFile = this.app.vault.getAbstractFileByPath(dataPath);
      
      if (!dataFile || !(dataFile instanceof TFile)) {
        return;
      }

      const content = await this.app.vault.read(dataFile);
      const runningTasksData = JSON.parse(content);

      if (!Array.isArray(runningTasksData)) {
        return;
      }

      // 現在の日付文字列を取得
      const currentDateString = this.getCurrentDateString();

      // 削除済みタスクリストを取得
      const deletedInstances = this.getDeletedInstances(currentDateString);
      const deletedTasks = deletedInstances
        .filter((inst) => inst.deletionType === "permanent")
        .map((inst) => inst.path);

      let restored = false;
      for (const runningData of runningTasksData) {
        
        if (runningData.date !== currentDateString) {
          continue;
        }

        // 削除済みタスクはスキップ
        if (runningData.taskPath && deletedTasks.includes(runningData.taskPath)) {
          continue;
        }

        // 既存のインスタンスを検索
        let runningInstance = this.taskInstances.find(
          (inst) =>
            inst.task.path === runningData.taskPath &&
            inst.state === "idle" &&
            (runningData.slotKey ? inst.slotKey === runningData.slotKey : true)
        );

        if (runningInstance) {
          runningInstance.state = "running";
          runningInstance.startTime = new Date(runningData.startTime);
          runningInstance.stopTime = null;
          this.currentInstance = runningInstance;
          restored = true;
        }
        // else: no matching instance, skip silently
      }

      if (restored) {
        this.startGlobalTimer(); // タイマー管理を再開
        this.renderTaskList(); // UIを更新
      }
    } catch (e) {
      console.error("[TaskChute] 実行中タスクの復元に失敗:", e);
    }
  }

  private saveInstanceState(inst: TaskInstance): void {
    const stateKey = `taskchute-instance-state-${inst.instanceId}`;
    const state = {
      state: inst.state,
      startTime: inst.startTime?.toISOString(),
      stopTime: inst.stopTime?.toISOString(),
      pausedDuration: inst.pausedDuration,
      actualMinutes: inst.actualMinutes,
      comment: inst.comment,
      focusLevel: inst.focusLevel,
      energyLevel: inst.energyLevel,
    };

    try {
      localStorage.setItem(stateKey, JSON.stringify(state));
    } catch (error) {
      console.error("Failed to save instance state:", error);
    }
  }

  private async saveTaskLog(inst: TaskInstance): Promise<void> {
    // Implementation for saving task log (placeholder)
  }

  // ===========================================
  // Timer Management Methods
  // ===========================================

  private startGlobalTimer(): void {
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval);
    }

    this.globalTimerInterval = setInterval(() => {
      this.updateAllTimers();
    }, 1000);
  }

  private updateAllTimers(): void {
    const runningInstances = this.taskInstances.filter(inst => inst.state === "running");
    
    if (runningInstances.length === 0) {
      this.stopGlobalTimer();
      return;
    }

    runningInstances.forEach(inst => {
      const timerEl = this.taskList.querySelector(`[data-task-path="${inst.task.path}"] .task-timer-display`) as HTMLElement;
      if (timerEl) {
        this.updateTimerDisplay(timerEl, inst);
      }
    });
  }

  private updateTimerDisplay(timerEl: HTMLElement, inst: TaskInstance): void {
    if (!inst.startTime) return;

    const now = new Date();
    const elapsed = now.getTime() - inst.startTime.getTime();
    const hours = Math.floor(elapsed / (1000 * 60 * 60));
    const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);
    
    // HH:MM:SS形式で表示（main.jsと同じ形式）
    timerEl.textContent = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  private stopGlobalTimer(): void {
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval);
      this.globalTimerInterval = null;
    }
  }

  // ===========================================
  // Event Handler Methods
  // ===========================================

  private setupEventListeners(): void {
    // Keyboard shortcut listener
    this.registerDomEvent(document, "keydown", (e) => {
      this.handleKeyboardShortcut(e);
    });

    // Click listener for clearing selection
    this.registerDomEvent(this.containerEl, "click", (e) => {
      if (!e.target.closest(".task-item")) {
        this.clearTaskSelection();
      }
    });

    // File rename event listener
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        await this.handleFileRename(file, oldPath);
      })
    );
  }

  private setupPlayStopButton(button: HTMLElement, inst: TaskInstance): void {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      
      if (inst.state === "running") {
        await this.stopInstance(inst);
      } else if (inst.state === "idle") {
        await this.startInstance(inst);
      }
    });
  }

  private setupTaskItemEventListeners(taskItem: HTMLElement, inst: TaskInstance): void {
    // Context menu
    taskItem.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showTaskContextMenu(e, inst);
    });

    // Drag and drop
    this.setupTaskItemDragDrop(taskItem, inst);
  }

  private setupTaskItemDragDrop(taskItem: HTMLElement, inst: TaskInstance): void {
    taskItem.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.handleDragOver(e, taskItem, inst);
    });

    taskItem.addEventListener("dragleave", () => {
      this.clearDragoverClasses(taskItem);
    });

    taskItem.addEventListener("drop", (e) => {
      e.preventDefault();
      this.handleDrop(e, taskItem, inst);
    });
  }

  private setupDragEvents(dragHandle: HTMLElement, taskItem: HTMLElement, slot: string, idx: number): void {
    dragHandle.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", `${slot ?? "none"}::${idx}`);
      taskItem.classList.add("dragging");
    });

    dragHandle.addEventListener("dragend", () => {
      taskItem.classList.remove("dragging");
    });
  }

  private setupTimeSlotDragHandlers(header: HTMLElement, slot: string): void {
    header.addEventListener("dragover", (e) => {
      e.preventDefault();
      header.classList.add("dragover");
    });

    header.addEventListener("dragleave", () => {
      header.classList.remove("dragover");
    });

    header.addEventListener("drop", (e) => {
      e.preventDefault();
      header.classList.remove("dragover");
      this.handleSlotDrop(e, slot);
    });
  }

  // ===========================================
  // Command Methods (for external commands)
  // ===========================================

  duplicateSelectedTask(): void {
    if (this.selectedTaskInstance) {
      this.duplicateTask(this.selectedTaskInstance);
    } else {
      new Notice("タスクが選択されていません");
    }
  }

  deleteSelectedTask(): void {
    if (this.selectedTaskInstance) {
      // 削除確認モーダルを表示
      this.showDeleteConfirmDialog(this.selectedTaskInstance).then((confirmed) => {
        if (confirmed) {
          this.deleteTask(this.selectedTaskInstance);
        }
      });
    } else {
      new Notice("タスクが選択されていません");
    }
  }

  resetSelectedTask(): void {
    if (this.selectedTaskInstance) {
      this.resetTask(this.selectedTaskInstance);
    } else {
      new Notice("タスクが選択されていません");
    }
  }

  showTodayTasks(): void {
    const today = new Date();
    this.currentDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    
    // カレンダー表示（日付ラベル）を更新
    const dateLabel = this.containerEl.querySelector('.date-nav-label') as HTMLElement;
    if (dateLabel) {
      this.updateDateLabel(dateLabel);
    }
    
    // タスクリストを更新
    this.loadTasks().then(() => {
      new Notice(`今日のタスクを表示しました`);
    });
  }

  reorganizeIdleTasks(): void {
    this.moveIdleTasksToCurrentTime();
    new Notice("アイドルタスクを整理しました");
  }

  // ===========================================
  // Utility Methods
  // ===========================================

  private getTimeSlotKeys(): string[] {
    return ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"];
  }

  private sortTaskInstancesByTimeOrder(): void {
    if (this.useOrderBasedSort) {
      // Load saved orders
      const savedOrders = this.loadSavedOrders();

      // Apply saved orders to instances (do not clear others yet)
      this.taskInstances.forEach(inst => {
        const key = `${inst.task.path || inst.instanceId}::${inst.slotKey || 'none'}`;
        if (savedOrders[key] !== undefined) {
          inst.order = savedOrders[key];
        }
      });

      // Initialize orders ONLY for tasks without order
      this.initializeTaskOrders();
    }
  }

  private initializeTaskOrders(): void {
    // Group tasks by slot
    const slotGroups: Record<string, TaskInstance[]> = {};

    this.taskInstances.forEach(inst => {
      const slot = inst.slotKey || 'none';
      if (!slotGroups[slot]) {
        slotGroups[slot] = [];
      }
      slotGroups[slot].push(inst);
    });

    // Assign order numbers per slot
    Object.keys(slotGroups).forEach(slot => {
      const instances = slotGroups[slot];

      // Split by state
      const done = instances.filter(i => i.state === 'done');
      const running = instances.filter(i => i.state === 'running' || i.state === 'paused');
      const idle = instances.filter(i => i.state === 'idle');

      let currentOrderBase = 0;

      // 1) Done: always order by startTime (ascending)
      done.sort((a, b) => {
        const ta = a.startTime ? a.startTime.getTime() : Infinity;
        const tb = b.startTime ? b.startTime.getTime() : Infinity;
        return ta - tb;
      });
      done.forEach((inst, idx) => {
        inst.order = (idx + 1) * 100;
      });
      currentOrderBase = done.length * 100;

      // 2) Running: preserve any existing order, assign if missing after done
      const existingRunningOrders = running
        .filter(i => i.order !== undefined && i.order !== null)
        .map(i => i.order as number);
      const maxExistingOrder = existingRunningOrders.length > 0
        ? Math.max(...existingRunningOrders)
        : currentOrderBase;

      let nextOrder = Math.max(currentOrderBase, maxExistingOrder) + 100;
      running
        .filter(i => i.order === undefined || i.order === null)
        .forEach(inst => {
          inst.order = nextOrder;
          nextOrder += 100;
        });

      // 3) Idle: keep saved order if present; otherwise assign by scheduledTime (HH:MM)
      const savedIdle = idle.filter(i => i.order !== undefined && i.order !== null);
      const unsavedIdle = idle.filter(i => i.order === undefined || i.order === null);

      // Compute base for new idle orders (after any existing order in this slot)
      const existingOrdersInSlot = instances
        .filter(i => i.order !== undefined && i.order !== null)
        .map(i => i.order as number);
      const idleBase = existingOrdersInSlot.length > 0 ? Math.max(...existingOrdersInSlot) : nextOrder - 100;

      // Sort unsaved idle by scheduledTime ascending (missing goes last)
      unsavedIdle.sort((a, b) => {
        const ta = a?.task?.scheduledTime;
        const tb = b?.task?.scheduledTime;
        if (!ta && !tb) return 0;
        if (!ta) return 1;
        if (!tb) return -1;
        const [ha, ma] = ta.split(':').map(n => parseInt(n, 10));
        const [hb, mb] = tb.split(':').map(n => parseInt(n, 10));
        return (ha * 60 + ma) - (hb * 60 + mb);
      });

      // Assign orders to unsaved idle starting after existing ones
      let idleOrder = idleBase + 100;
      unsavedIdle.forEach(inst => {
        inst.order = idleOrder;
        idleOrder += 100;
      });
    });

    // Save new/updated orders only
    this.saveTaskOrders();
  }

  private saveTaskOrders(): void {
    const dateStr = this.getCurrentDateString();
    const orderKey = `taskchute-orders-${dateStr}`;
    
    const orders: Record<string, number> = {};
    this.taskInstances.forEach(inst => {
      if (inst.order !== undefined) {
        const key = `${inst.task.path || inst.instanceId}::${inst.slotKey || 'none'}`;
        orders[key] = inst.order;
      }
    });
    
    try {
      localStorage.setItem(orderKey, JSON.stringify(orders));
    } catch (error) {
      console.error('Failed to save task orders:', error);
    }
  }

  private loadSavedOrders(): Record<string, number> {
    const dateStr = this.getCurrentDateString();
    const orderKey = `taskchute-orders-${dateStr}`;
    
    try {
      const saved = localStorage.getItem(orderKey);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('Failed to load saved orders:', error);
    }
    
    return {};
  }

  private sortByOrder(instances: TaskInstance[]): TaskInstance[] {
    return instances.sort((a, b) => {
      // 1) State priority: done (top) -> running/paused -> idle
      const statePriority: Record<string, number> = { done: 0, running: 1, paused: 1, idle: 2 };
      const sa = statePriority[a.state] ?? 3;
      const sb = statePriority[b.state] ?? 3;
      if (sa !== sb) return sa - sb;

      // 2) Order comparison
      const hasOrderA = a.order !== undefined && a.order !== null;
      const hasOrderB = b.order !== undefined && b.order !== null;
      if (hasOrderA && hasOrderB) {
        if (a.order! !== b.order!) return (a.order! - b.order!);
        // If equal, fall through to time-based tiebreaker
      } else if (hasOrderA && !hasOrderB) {
        return -1; // With order comes first
      } else if (!hasOrderA && hasOrderB) {
        return 1; // With order comes first
      }

      // 3) Fallback: time-based
      if (a.state === 'done' && b.state === 'done') {
        const ta = a.startTime ? a.startTime.getTime() : Infinity;
        const tb = b.startTime ? b.startTime.getTime() : Infinity;
        if (ta !== tb) return ta - tb;
        return 0;
      }

      // For running/idle/paused: use scheduledTime (HH:MM)
      const tA = (a as any)?.task?.scheduledTime as string | undefined;
      const tB = (b as any)?.task?.scheduledTime as string | undefined;
      if (!tA && !tB) return 0;
      if (!tA) return 1;
      if (!tB) return -1;
      const [ha, ma] = tA.split(':').map(n => parseInt(n, 10));
      const [hb, mb] = tB.split(':').map(n => parseInt(n, 10));
      return (ha * 60 + ma) - (hb * 60 + mb);
    });
  }

  private moveTaskToSlot(inst: TaskInstance, newSlot: string, position?: number): void {
    // Update slot
    const oldSlot = inst.slotKey;
    inst.slotKey = newSlot;
    
    // Get all tasks in the target slot (excluding the moving task)
    const slotTasks = this.taskInstances.filter(
      t => t.slotKey === newSlot && t !== inst
    );
    
    // Sort existing tasks by their current order
    this.sortByOrder(slotTasks);
    
    // Insert the task at the specified position
    if (position !== undefined && position >= 0) {
      // Insert at specific position
      slotTasks.splice(position, 0, inst);
    } else {
      // Add to the end
      slotTasks.push(inst);
    }
    
    // Reassign order numbers for all tasks in the slot
    slotTasks.forEach((task, idx) => {
      task.order = idx;
    });
    
    // Save changes
    this.saveTaskOrders();
    this.renderTaskList();
  }

  private applyResponsiveClasses(): void {
    // Apply responsive classes based on pane width
    const width = this.containerEl.clientWidth;
    const classList = this.containerEl.classList;
    
    classList.remove("narrow", "medium", "wide");
    
    if (width < 400) {
      classList.add("narrow");
    } else if (width < 600) {
      classList.add("medium");
    } else {
      classList.add("wide");
    }
  }

  private setupResizeObserver(): void {
    const resizeObserver = new ResizeObserver(() => {
      this.applyResponsiveClasses();
    });
    
    resizeObserver.observe(this.containerEl);
  }

  private initializeNavigationEventListeners(): void {
    // Navigation toggle
    const drawerToggle = this.containerEl.querySelector(".drawer-toggle") as HTMLElement;
    if (drawerToggle) {
      drawerToggle.addEventListener("click", () => {
        this.toggleNavigation();
      });
    }

    // Overlay click to close
    if (this.navigationOverlay) {
      this.navigationOverlay.addEventListener("click", () => {
        this.closeNavigation();
      });
    }
  }

  private scheduleBoundaryCheck(): void {
    // Schedule boundary check for idle-task-auto-move feature
    const now = new Date();
    const boundaries: TimeBoundary[] = [
      { hour: 0, minute: 0 },
      { hour: 8, minute: 0 },
      { hour: 12, minute: 0 },
      { hour: 16, minute: 0 },
    ];

    const next = calculateNextBoundary(now, boundaries);
    // Run 1s after boundary to avoid edge jitter
    const delay = Math.max(0, next.getTime() - now.getTime() + 1000);

    this.boundaryCheckTimeout = setTimeout(() => {
      this.checkBoundaryTasks();
      this.scheduleBoundaryCheck(); // Reschedule
    }, delay);
  }

  private checkBoundaryTasks(): void {
    try {
      // Only act on today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const viewDate = new Date(this.currentDate);
      viewDate.setHours(0, 0, 0, 0);
      if (viewDate.getTime() !== today.getTime()) return;

      // Current slot based on now
      const currentSlot = getCurrentTimeSlot(new Date());
      const slots = this.getTimeSlotKeys();
      const currentIndex = slots.indexOf(currentSlot);
      if (currentIndex < 0) return; // safety

      let moved = false;
      this.taskInstances.forEach((inst) => {
        if (inst.state !== 'idle') return;
        const slot = inst.slotKey || 'none';
        if (slot === 'none') return;
        const idx = slots.indexOf(slot);
        if (idx >= 0 && idx < currentIndex) {
          // Past slot → move into current slot
          inst.slotKey = currentSlot;
          moved = true;
        }
      });

      if (moved) {
        // Recompute orders per spec and rerender
        this.initializeTaskOrders();
        this.renderTaskList();
      }
    } catch (e) {
      // Fail-safe: don't crash view on timer
      console.error('[TaskChute] boundary move failed:', e);
    }
  }

  private updateTotalTasksCount(): void {
    // Update task count for heatmap
    const completedTasks = this.taskInstances.filter(inst => inst.state === "done");
    // Implementation would save this to the appropriate data structure
  }

  private cleanupAutocompleteInstances(): void {
    if (this.autocompleteInstances) {
      this.autocompleteInstances.forEach((instance) => {
        if (instance && instance.cleanup) {
          instance.cleanup();
        }
      });
      this.autocompleteInstances = [];
    }
  }

  private cleanupTimers(): void {
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval);
      this.globalTimerInterval = null;
    }

    if (this.boundaryCheckTimeout) {
      clearTimeout(this.boundaryCheckTimeout);
      this.boundaryCheckTimeout = null;
    }

    if (this.renderDebounceTimer) {
      clearTimeout(this.renderDebounceTimer);
      this.renderDebounceTimer = null;
    }
  }

  private applyStyles(): void {
    // Create and inject dynamic styles
    const style = document.createElement("style");
    style.textContent = TASKCHUTE_FULL_CSS;
    document.head.appendChild(style);
  }

  // ===========================================
  // Placeholder Methods (to be implemented)
  // ===========================================


  private async handleNavigationItemClick(section: 'routine' | 'review' | 'log' | 'project'): Promise<void> {
    if (section === 'log') {
      this.openLogModal();
      this.closeNavigation();
      return;
    }
    if (section === 'review') {
      await this.showReviewSection();
      this.closeNavigation();
      return;
    }
    new Notice(`${section} 機能は実装中です`);
  }

  // Show Daily Review in right split
  private async showReviewSection(): Promise<void> {
    try {
      // Determine date string; clamp future to today
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const selectedStr = this.getCurrentDateString();
      const reviewDate = new Date(selectedStr);
      const dateStr = reviewDate > new Date(todayStr) ? todayStr : selectedStr;

      const review = new ReviewService(this.plugin);
      const file = await review.ensureReviewFile(dateStr);
      await review.openInSplit(file, this.leaf);
    } catch (error: any) {
      new Notice('レビューの表示に失敗しました: ' + (error?.message || error));
    }
  }

  private openLogModal(): void {
    const overlay = document.createElement('div');
    overlay.className = 'taskchute-log-modal-overlay';
    const content = overlay.createEl('div', { cls: 'taskchute-log-modal-content' });
    const closeBtn = content.createEl('button', { cls: 'log-modal-close', text: '×', attr: { title: '閉じる' } });
    closeBtn.addEventListener('click', () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    });

    const logView = new LogView(this.plugin as any, content);
    logView.render();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    });

    document.body.appendChild(overlay);
  }

  private handleKeyboardShortcut(e: KeyboardEvent): void {
    // Implement keyboard shortcuts
  }

  private selectTaskForKeyboard(inst: TaskInstance, taskItem: HTMLElement): void {
    this.selectedTaskInstance = inst;
    
    // Clear previous selections
    this.containerEl.querySelectorAll(".task-item.keyboard-selected")
      .forEach(el => el.classList.remove("keyboard-selected"));
    
    // Add selection to current item
    taskItem.classList.add("keyboard-selected");
  }

  private clearTaskSelection(): void {
    this.selectedTaskInstance = null;
    this.containerEl.querySelectorAll(".task-item.keyboard-selected")
      .forEach(el => el.classList.remove("keyboard-selected"));
  }

  private async deleteTask(inst: TaskInstance): Promise<void> {
    if (!inst) return;
    
    // 非ルーチンタスクの削除処理
    if (!inst.task.isRoutine) {
      await this.deleteNonRoutineTask(inst);
    } else {
      // ルーチンタスクの削除処理
      await this.deleteRoutineTask(inst);
    }
  }

  private async deleteNonRoutineTask(inst: TaskInstance): Promise<void> {
    // 非ルーチンタスクの削除はdeleteInstanceメソッドに統一
    await this.deleteInstance(inst);
  }

  private async deleteRoutineTask(inst: TaskInstance): Promise<void> {
    // ルーチンタスクの削除もdeleteInstanceメソッドに統一
    // ただし、hidden routinesに追加する処理が必要
    const dateStr = this.getCurrentDateString();
    const hiddenKey = `taskchute-hidden-routines-${dateStr}`;
    const hiddenRoutines = JSON.parse(localStorage.getItem(hiddenKey) || '[]');
    
    // 複製タスクかチェック
    const isDuplicated = this.isDuplicatedTask(inst);
    
    const alreadyHidden = hiddenRoutines.some((h: any) => {
      if (isDuplicated) {
        return h.instanceId === inst.instanceId;
      }
      if (typeof h === 'string') {
        return h === inst.task.path;
      }
      return h.path === inst.task.path && !h.instanceId;
    });
    
    if (!alreadyHidden) {
      if (isDuplicated) {
        hiddenRoutines.push({
          path: inst.task.path,
          instanceId: inst.instanceId
        });
      } else {
        hiddenRoutines.push({
          path: inst.task.path,
          instanceId: null
        });
      }
      localStorage.setItem(hiddenKey, JSON.stringify(hiddenRoutines));
    }
    
    // 実行履歴から削除
    if (inst.instanceId) {
      await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId);
    }
    
    // deleteInstanceを呼ぶ
    await this.deleteInstance(inst);
  }

  private isDuplicatedTask(inst: TaskInstance): boolean {
    const dateStr = this.getCurrentDateString();
    const duplicationKey = `taskchute-duplicated-instances-${dateStr}`;
    const duplicatedInstances = JSON.parse(localStorage.getItem(duplicationKey) || '[]');
    return duplicatedInstances.some((d: any) => d.instanceId === inst.instanceId);
  }

  private async deleteTaskLogsByInstanceId(taskPath: string, instanceId: string): Promise<number> {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const [year, month] = this.getCurrentDateString().split('-');
      const monthString = `${year}-${month}`;
      const logPath = `${logDataPath}/${monthString}-tasks.json`;
      
      const logFile = this.app.vault.getAbstractFileByPath(logPath);
      if (!logFile || !(logFile instanceof TFile)) {
        return 0;
      }
      
      const content = await this.app.vault.read(logFile);
      const monthlyLog = JSON.parse(content);
      
      let deletedCount = 0;
      for (const dateKey in monthlyLog.taskExecutions) {
        const dayExecutions = monthlyLog.taskExecutions[dateKey];
        const beforeLength = dayExecutions.length;
        monthlyLog.taskExecutions[dateKey] = dayExecutions.filter(
          (exec: any) => exec.instanceId !== instanceId
        );
        deletedCount += beforeLength - monthlyLog.taskExecutions[dateKey].length;
      }
      
      if (deletedCount > 0) {
        await this.app.vault.modify(logFile, JSON.stringify(monthlyLog, null, 2));
      }
      
      return deletedCount;
    } catch (error) {
      console.error('Failed to delete task logs:', error);
      return 0;
    }
  }

  private showTaskContextMenu(e: MouseEvent, inst: TaskInstance): void {
    new Notice("コンテキストメニューは実装中です");
  }

  private handleDragOver(e: DragEvent, taskItem: HTMLElement, inst: TaskInstance): void {
    e.preventDefault();
    
    // Clear previous classes
    this.clearDragoverClasses(taskItem);
    
    // Don't show indicators for completed tasks
    if (inst.state === 'done') {
      taskItem.classList.add('dragover-invalid');
      return;
    }
    
    // Calculate drop position based on mouse position
    const rect = taskItem.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;
    const isBottomHalf = y > height / 2;
    
    // Add appropriate visual feedback
    if (isBottomHalf) {
      taskItem.classList.add('dragover-bottom');
    } else {
      taskItem.classList.add('dragover-top');
    }
  }

  private clearDragoverClasses(taskItem: HTMLElement): void {
    taskItem.classList.remove("dragover", "dragover-top", "dragover-bottom", "dragover-invalid");
  }

  private handleDrop(e: DragEvent, taskItem: HTMLElement, targetInst: TaskInstance): void {
    const data = e.dataTransfer?.getData("text/plain");
    if (!data) return;
    
    const [sourceSlot, sourceIdx] = data.split("::");
    const targetSlot = targetInst.slotKey || "none";
    
    // Find the source instance
    const sourceInst = this.taskInstances.find(inst => {
      const instSlot = inst.slotKey || "none";
      const slotInstances = this.taskInstances.filter(t => (t.slotKey || "none") === instSlot);
      const sortedSlotInstances = this.sortByOrder(slotInstances);
      const idx = sortedSlotInstances.indexOf(inst);
      return instSlot === sourceSlot && idx === parseInt(sourceIdx);
    });
    
    if (!sourceInst || sourceInst.state === "done") return;
    
    // Calculate drop position
    const rect = taskItem.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const isBottomHalf = y > rect.height / 2;
    
    // Get tasks in target slot
    const targetSlotTasks = this.taskInstances.filter(
      t => (t.slotKey || "none") === targetSlot
    );
    const sortedTargetTasks = this.sortByOrder(targetSlotTasks);
    
    // Find target position
    const targetIndex = sortedTargetTasks.indexOf(targetInst);
    let newPosition = isBottomHalf ? targetIndex + 1 : targetIndex;
    
    // If moving within the same slot, adjust position
    if (sourceSlot === targetSlot) {
      const sourceIndex = sortedTargetTasks.indexOf(sourceInst);
      if (sourceIndex < newPosition) {
        newPosition--;
      }
    }
    
    // Move the task
    this.moveTaskToSlot(sourceInst, targetSlot, newPosition);
  }

  private handleSlotDrop(e: DragEvent, slot: string): void {
    const data = e.dataTransfer?.getData("text/plain");
    if (!data) return;
    
    const [sourceSlot, sourceIdx] = data.split("::");
    
    // Find the source instance
    const sourceInst = this.taskInstances.find(inst => {
      const instSlot = inst.slotKey || "none";
      const slotInstances = this.taskInstances.filter(t => (t.slotKey || "none") === instSlot);
      const sortedSlotInstances = this.sortByOrder(slotInstances);
      const idx = sortedSlotInstances.indexOf(inst);
      return instSlot === sourceSlot && idx === parseInt(sourceIdx);
    });
    
    if (!sourceInst || sourceInst.state === "done") return;
    
    // Move to the end of the target slot
    this.moveTaskToSlot(sourceInst, slot);
  }

  private toggleNavigation(): void {
    this.navigationState.isOpen = !this.navigationState.isOpen;
    
    if (this.navigationState.isOpen) {
      this.openNavigation();
    } else {
      this.closeNavigation();
    }
  }

  private openNavigation(): void {
    this.navigationPanel.classList.remove("navigation-panel-hidden");
    this.navigationOverlay.classList.remove("navigation-overlay-hidden");
  }

  private closeNavigation(): void {
    this.navigationPanel.classList.add("navigation-panel-hidden");
    this.navigationOverlay.classList.add("navigation-overlay-hidden");
  }

  private async setRoutineTask(task: any, button: HTMLElement, scheduledTime: string): Promise<void> {
    try {
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
      const filePath = `${taskFolderPath}/${task.title}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (!file || !(file instanceof TFile)) {
        new Notice(`タスクファイル「${task.title}.md」が見つかりません`);
        return;
      }
      
      // ルーチンタスクとして設定
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.isRoutine = true;
        frontmatter.開始時刻 = scheduledTime;
        frontmatter.routine_type = "daily";
        const y = this.currentDate.getFullYear();
        const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
        const d = this.currentDate.getDate().toString().padStart(2, "0");
        frontmatter.routine_start = `${y}-${m}-${d}`;
        delete frontmatter.routine_end;
        return frontmatter;
      });
      
      // 状態更新
      task.isRoutine = true;
      task.scheduledTime = scheduledTime;
      button.classList.add("active");
      button.setAttribute("title", `ルーチンタスク（${scheduledTime}開始予定）`);
      
      // タスク情報を再取得し、UIを最新化
      await this.loadTasks();
      new Notice(`「${task.title}」をルーチンタスクに設定しました（${scheduledTime}開始予定）`);
    } catch (error) {
      console.error("Failed to set routine task:", error);
      new Notice("ルーチンタスクの設定に失敗しました");
    }
  }

  private async setRoutineTaskWithDetails(
    task: any, 
    button: HTMLElement, 
    scheduledTime: string, 
    routineType: string,
    details: {
      weekdays?: number[];
      monthly_week?: number;
      monthly_weekday?: number;
    }
  ): Promise<void> {
    try {
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
      const filePath = `${taskFolderPath}/${task.title}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (!file || !(file instanceof TFile)) {
        new Notice(`タスクファイル「${task.title}.md」が見つかりません`);
        return;
      }
      
      // ルーチンタスクとして設定
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter.isRoutine = true;
        frontmatter.開始時刻 = scheduledTime;
        frontmatter.routine_type = routineType;
        
        // 現在の日付を設定
        const y = this.currentDate.getFullYear();
        const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0");
        const d = this.currentDate.getDate().toString().padStart(2, "0");
        frontmatter.routine_start = `${y}-${m}-${d}`;
        
        // 既存のルーチン設定をクリア
        delete frontmatter.routine_end;
        delete frontmatter.weekday;
        delete frontmatter.weekdays;
        delete frontmatter.monthly_week;
        delete frontmatter.monthly_weekday;
        
        // タイプに応じて設定を追加
        switch (routineType) {
          case "daily":
          case "weekdays":
          case "weekends":
            // これらのタイプは追加設定不要
            break;
            
          case "weekly":
            if (details.weekdays && details.weekdays.length > 0) {
              if (details.weekdays.length === 1) {
                // 単一曜日の場合
                frontmatter.weekday = details.weekdays[0];
              } else {
                // 複数曜日の場合
                frontmatter.weekdays = details.weekdays;
              }
            }
            break;
            
          case "monthly":
            if (details.monthly_week !== undefined && details.monthly_weekday !== undefined) {
              frontmatter.monthly_week = details.monthly_week;
              frontmatter.monthly_weekday = details.monthly_weekday;
            }
            break;
        }
        
        return frontmatter;
      });
      
      // 状態更新
      task.isRoutine = true;
      task.scheduledTime = scheduledTime;
      task.routine_type = routineType;
      
      // タイプに応じて詳細情報も更新
      if (routineType === "weekly" && details.weekdays) {
        task.weekdays = details.weekdays;
      } else if (routineType === "monthly") {
        task.monthly_week = details.monthly_week;
        task.monthly_weekday = details.monthly_weekday;
      }
      
      button.classList.add("active");
      
      // ツールチップテキストを生成
      let tooltipText = `ルーチンタスク（${scheduledTime}開始予定）`;
      switch (routineType) {
        case "daily":
          tooltipText += " - 毎日";
          break;
        case "weekdays":
          tooltipText += " - 平日のみ";
          break;
        case "weekends":
          tooltipText += " - 週末のみ";
          break;
        case "weekly":
          if (details.weekdays) {
            const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
            const days = details.weekdays.map(d => dayNames[d]).join(",");
            tooltipText += ` - 毎週${days}`;
          }
          break;
        case "monthly":
          if (details.monthly_week !== undefined && details.monthly_weekday !== undefined) {
            const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
            tooltipText += ` - 第${details.monthly_week + 1}${dayNames[details.monthly_weekday]}曜日`;
          }
          break;
      }
      
      button.setAttribute("title", tooltipText);
      
      // タスク情報を再取得し、UIを最新化
      await this.loadTasks();
      new Notice(`「${task.title}」をルーチンタスクに設定しました`);
    } catch (error) {
      console.error("Failed to set routine task:", error);
      new Notice("ルーチンタスクの設定に失敗しました");
    }
  }

  private async deleteInstanceWithConfirm(inst: TaskInstance): Promise<void> {
    const confirmed = await this.showDeleteConfirmDialog(inst);
    if (confirmed) {
      await this.deleteInstance(inst);
    }
  }
  
  private showDeleteConfirmDialog(inst: TaskInstance): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.className = "task-modal-overlay";
      const modalContent = modal.createEl("div", { cls: "task-modal-content" });
      
      modalContent.createEl("h3", { text: "タスクの削除確認" });
      modalContent.createEl("p", {
        text: `「${inst.task.title}」を削除してもよろしいですか？`,
      });
      
      const buttonContainer = modalContent.createEl("div", {
        cls: "modal-button-container",
      });
      
      const confirmButton = buttonContainer.createEl("button", {
        text: "削除",
        cls: "mod-cta",
      });
      
      const cancelButton = buttonContainer.createEl("button", {
        text: "キャンセル",
      });
      
      confirmButton.addEventListener("click", () => {
        modal.remove();
        resolve(true);
      });
      
      cancelButton.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });
      
      document.body.appendChild(modal);
    });
  }
  
  private async deleteInstance(inst: TaskInstance): Promise<void> {
    try {
      // インスタンスをリストから削除
      const index = this.taskInstances.indexOf(inst);
      if (index > -1) {
        this.taskInstances.splice(index, 1);
      }
      
      // 削除状態を保存
      const dateStr = this.getCurrentDateString();
      const deletedInstances = this.getDeletedInstances(dateStr);
      deletedInstances.push({
        instanceId: inst.instanceId,
        path: inst.task.path,
        deletionType: inst.task.isRoutine ? "today" : "permanent",
        deletedAt: new Date().toISOString(),
      });
      this.saveDeletedInstances(dateStr, deletedInstances);
      
      // 非ルーチンタスクの場合、同じパスの他のインスタンスがなければファイルも削除
      if (!inst.task.isRoutine) {
        const samePathInstances = this.taskInstances.filter(
          (i) => i.task.path === inst.task.path
        );
        
        if (samePathInstances.length === 0 && inst.task.file) {
          // 最後のインスタンスの場合、ファイルも削除
          this.tasks = this.tasks.filter((t) => t.path !== inst.task.path);
          await this.app.vault.delete(inst.task.file);
          new Notice(`「${inst.task.title}」を完全に削除しました。`);
        } else {
          new Notice(`「${inst.task.title}」を本日のリストから削除しました。`);
        }
      } else {
        new Notice(`「${inst.task.title}」を本日のリストから削除しました。`);
      }
      
      // UIを更新
      this.renderTaskList();
    } catch (error) {
      console.error("Failed to delete instance:", error);
      new Notice("タスクの削除に失敗しました");
    }
  }

  private async resetTaskToIdle(inst: TaskInstance): Promise<void> {
    try {
      // 状態をidleにリセット
      inst.state = "idle";
      inst.startTime = undefined;
      inst.stopTime = undefined;
      
      // 状態を保存
      this.saveInstanceState(inst);
      
      // UIを更新
      this.renderTaskList();
      
      new Notice(`「${inst.task.title}」をアイドル状態に戻しました`);
    } catch (error) {
      console.error("Failed to reset task:", error);
      new Notice("タスクのリセットに失敗しました");
    }
  }
  
  private async showProjectSettingsModal(inst: TaskInstance, tooltip: HTMLElement): Promise<void> {
    // ツールチップを閉じる
    if (tooltip) {
      tooltip.remove();
    }
    
    // モーダルコンテナ
    const modal = document.createElement("div");
    modal.className = "task-modal-overlay";
    const modalContent = modal.createEl("div", { cls: "task-modal-content" });
    
    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
    modalHeader.createEl("h3", {
      text: `「${inst.task.title}」のプロジェクト設定`,
    });
    
    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
    });
    
    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" });
    
    // プロジェクト選択
    const projectGroup = form.createEl("div", { cls: "form-group" });
    projectGroup.createEl("label", { text: "プロジェクト:", cls: "form-label" });
    const projectSelect = projectGroup.createEl("select", {
      cls: "form-select",
    }) as HTMLSelectElement;
    
    // プロジェクトリストを取得してオプションを追加
    const projects = await this.getAvailableProjects();
    
    // 「プロジェクトなし」オプション
    const noneOption = projectSelect.createEl("option", {
      value: "",
      text: "プロジェクトなし",
    });
    
    projects.forEach((project) => {
      projectSelect.createEl("option", {
        value: project,
        text: project,
      });
    });
    
    // 現在のプロジェクトを選択
    if (inst.task.project) {
      projectSelect.value = inst.task.project;
    }
    
    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" });
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    });
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    });
    
    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const selectedProject = projectSelect.value;
      
      // プロジェクトを更新
      await this.updateTaskProject(inst, selectedProject);
      document.body.removeChild(modal);
    });
    
    // モーダルを表示
    document.body.appendChild(modal);
  }
  
  private async getAvailableProjects(): Promise<string[]> {
    try {
      const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
      const projectFolder = this.app.vault.getAbstractFileByPath(projectFolderPath);
      
      if (!projectFolder || !('children' in projectFolder)) {
        return [];
      }
      
      const projects: string[] = [];
      for (const file of projectFolder.children) {
        if (file instanceof TFile && file.extension === "md") {
          projects.push(file.basename);
        }
      }
      
      return projects;
    } catch (error) {
      console.error("Failed to get projects:", error);
      return [];
    }
  }
  
  private async updateTaskProject(inst: TaskInstance, projectName: string): Promise<void> {
    try {
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
      const filePath = `${taskFolderPath}/${inst.task.title}.md`;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (!file || !(file instanceof TFile)) {
        new Notice(`タスクファイル「${inst.task.title}.md」が見つかりません`);
        return;
      }
      
      // プロジェクトを更新
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        if (projectName) {
          frontmatter.project = `[[${projectName}]]`;
          frontmatter.project_path = `TaskChute/Project/${projectName}.md`;
        } else {
          delete frontmatter.project;
          delete frontmatter.project_path;
        }
        return frontmatter;
      });
      
      // タスクオブジェクトを更新
      inst.task.project = projectName || undefined;
      inst.task.projectPath = projectName ? `TaskChute/Project/${projectName}.md` : undefined;
      inst.task.projectTitle = projectName || undefined;
      
      // UIを更新
      this.renderTaskList();
      
      const message = projectName
        ? `「${inst.task.title}」を${projectName}に関連付けました`
        : `「${inst.task.title}」のプロジェクト関連付けを解除しました`;
      new Notice(message);
    } catch (error) {
      console.error("Failed to update project:", error);
      new Notice("プロジェクトの更新に失敗しました");
    }
  }

  private moveIdleTasksToCurrentTime(): void {
    new Notice("アイドルタスク移動機能は実装中です");
  }
  
  private async showAddTaskModal(): Promise<void> {
    // モーダルコンテナ
    const modal = document.createElement("div");
    modal.className = "task-modal-overlay";
    const modalContent = modal.createEl("div", { cls: "task-modal-content" });
    
    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
    modalHeader.createEl("h3", { text: "新しいタスクを追加" });
    
    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
    });
    
    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" });
    
    // タスク名入力
    const nameGroup = form.createEl("div", { cls: "form-group" });
    nameGroup.createEl("label", { text: "タスク名:", cls: "form-label" });
    const nameInput = nameGroup.createEl("input", {
      type: "text",
      cls: "form-input",
      placeholder: "タスク名を入力",
    }) as HTMLInputElement;
    
    // 見積時間は固定値30分を使用（UIには表示しない）
    const estimatedMinutes = 30;
    
    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" });
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    });
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    });
    
    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal);
    });
    
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const taskName = nameInput.value.trim();
      
      if (!taskName) {
        new Notice("タスク名を入力してください");
        return;
      }
      
      // タスクを作成（見積時間は30分固定）
      await this.createNewTask(taskName, estimatedMinutes);
      document.body.removeChild(modal);
    });
    
    // モーダルを表示
    document.body.appendChild(modal);
    nameInput.focus();
  }
  
  private async createNewTask(taskName: string, estimatedMinutes: number): Promise<void> {
    try {
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
      const filePath = `${taskFolderPath}/${taskName}.md`;
      
      // 現在表示中の日付を取得
      const dateStr = this.getCurrentDateString();
      
      // フロントマターを作成（非ルーチンタスクはtarget_dateのみ）
      const frontmatter = [
        "---",
        `target_date: "${dateStr}"`,
        "---",
        "",
        `#task`,
        "",
        `# ${taskName}`,
        ""
      ].join("\n");
      
      // ファイルを作成
      await this.app.vault.create(filePath, frontmatter);
      
      // 少し待ってからタスクリストを更新（ファイルシステムの同期を待つ）
      setTimeout(async () => {
        await this.loadTasks();
        this.renderTaskList();
      }, 100);
      
      new Notice(`タスク「${taskName}」を作成しました`);
    } catch (error) {
      console.error("Failed to create task:", error);
      new Notice("タスクの作成に失敗しました");
    }
  }
  
  private async showTaskMoveDatePicker(inst: TaskInstance, button: HTMLElement): Promise<void> {
    // 日付選択モーダルを表示
    const modal = document.createElement("div");
    modal.className = "task-modal-overlay";
    const modalContent = modal.createEl("div", { cls: "task-modal-content" });
    
    modalContent.createEl("h3", { text: "タスクを移動" });
    
    const dateInput = modalContent.createEl("input", {
      type: "date",
      value: this.getCurrentDateString(),
    }) as HTMLInputElement;
    
    const buttonContainer = modalContent.createEl("div", {
      cls: "modal-button-container",
    });
    
    const cancelButton = buttonContainer.createEl("button", {
      text: "キャンセル",
    });
    
    const moveButton = buttonContainer.createEl("button", {
      text: "移動",
      cls: "mod-cta",
    });
    
    cancelButton.addEventListener("click", () => {
      modal.remove();
    });
    
    moveButton.addEventListener("click", async () => {
      const newDate = dateInput.value;
      if (newDate) {
        await this.moveTaskToDate(inst, newDate);
        modal.remove();
      }
    });
    
    document.body.appendChild(modal);
  }
  
  private async moveTaskToDate(inst: TaskInstance, dateStr: string): Promise<void> {
    try {
      // タスクを指定日付に移動
      const file = this.app.vault.getAbstractFileByPath(inst.task.path);
      if (file instanceof TFile) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter.target_date = dateStr;
          return frontmatter;
        });
      }
      
      new Notice(`タスク「${inst.task.title}」を${dateStr}に移動しました`);
      await this.loadTasks();
    } catch (error) {
      console.error("Failed to move task:", error);
      new Notice("タスクの移動に失敗しました");
    }
  }
  
  private async showProjectModal(inst: TaskInstance): Promise<void> {
    // showProjectModal calls showUnifiedProjectModal internally
    await this.showUnifiedProjectModal(inst);
  }
  
  private async showUnifiedProjectModal(inst: TaskInstance): Promise<void> {
    try {
      // Create modal overlay
      const modal = document.createElement("div");
      modal.className = "task-modal-overlay";
      const modalContent = modal.createEl("div", { cls: "task-modal-content" });
      
      // Modal header
      const modalHeader = modalContent.createEl("div", { cls: "modal-header" });
      modalHeader.createEl("h3", {
        text: `「${inst.task.title}」のプロジェクト設定`,
      });
      
      // Close button
      const closeButton = modalHeader.createEl("button", {
        cls: "modal-close-button",
        text: "×",
        attr: { title: "閉じる" },
      });
      
      // Form
      const form = modalContent.createEl("form", { cls: "task-form" });
      
      // Get project list
      let projectFiles: TFile[] = [];
      try {
        projectFiles = await this.getProjectFiles();
      } catch (error) {
        new Notice("プロジェクトリストの読み込みに失敗しました");
        modal.remove();
        return;
      }
      
      if (projectFiles.length === 0) {
        // No project files found
        const noProjectGroup = form.createEl("div", { cls: "form-group" });
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルが見つかりません。",
          cls: "form-description",
        });
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルに #project タグを追加してください。",
          cls: "form-description",
        });
      } else {
        // Project selection
        const projectGroup = form.createEl("div", { cls: "form-group" });
        projectGroup.createEl("label", {
          text: "プロジェクトを選択:",
          cls: "form-label",
        });
        const projectSelect = projectGroup.createEl("select", {
          cls: "form-input",
        });
        
        // Add "Remove project" option if project is already set
        if (inst.task.projectPath) {
          const removeProjectOption = projectSelect.createEl("option", {
            value: "",
            text: "➖ プロジェクトを外す",
          });
        } else {
          // Add empty option if no project is set
          const emptyOption = projectSelect.createEl("option", {
            value: "",
            text: "",
          });
          emptyOption.selected = true;
        }
        
        // Add project list
        projectFiles.forEach((project) => {
          const option = projectSelect.createEl("option", {
            value: project.path,
            text: project.basename,
          });
          // Select current project if set
          if (inst.task.projectPath === project.path) {
            option.selected = true;
          }
        });
        
        // Description
        const descGroup = form.createEl("div", { cls: "form-group" });
        if (inst.task.projectPath) {
          descGroup.createEl("p", {
            text: "別のプロジェクトを選択するか、「プロジェクトを外す」を選択してプロジェクトを解除できます。",
            cls: "form-description",
          });
        } else {
          descGroup.createEl("p", {
            text: "タスクにプロジェクトを設定すると、プロジェクトページから関連タスクを確認できます。",
            cls: "form-description",
          });
        }
        
        // Buttons
        const buttonGroup = form.createEl("div", { cls: "form-button-group" });
        const cancelButton = buttonGroup.createEl("button", {
          type: "button",
          cls: "form-button cancel",
          text: "キャンセル",
        });
        const saveButton = buttonGroup.createEl("button", {
          type: "submit",
          cls: "form-button create",
          text: "保存",
        });
        
        // Event listeners
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const selectedProject = projectSelect.value;
          await this.setProjectForTask(inst.task, selectedProject);
          this.updateProjectDisplay(inst);
          modal.remove();
        });
        
        cancelButton.addEventListener("click", () => {
          modal.remove();
        });
      }
      
      closeButton.addEventListener("click", () => {
        modal.remove();
      });
      
      // Show modal
      document.body.appendChild(modal);
    } catch (error) {
      console.error("Failed to show project modal:", error);
      new Notice("プロジェクト選択画面の表示に失敗しました");
    }
  }
  
  private async getProjectFiles(): Promise<TFile[]> {
    const files = this.app.vault.getMarkdownFiles();
    const projectFiles: TFile[] = [];
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    
    for (const file of files) {
      // Get files that start with "Project - " in the project folder
      if (
        file.path.startsWith(projectFolderPath + "/") &&
        file.basename.startsWith("Project - ")
      ) {
        projectFiles.push(file);
        continue;
      }
      
      // For compatibility, also search for files starting with "Project - " in other folders
      if (file.basename.startsWith("Project - ")) {
        projectFiles.push(file);
        continue;
      }
      
      // Also check for #project tag
      const content = await this.app.vault.read(file);
      if (content.includes("#project")) {
        projectFiles.push(file);
      }
    }
    
    return projectFiles;
  }
  
  private async setProjectForTask(task: any, projectPath: string): Promise<void> {
    try {
      if (!task.file || !(task.file instanceof TFile)) {
        new Notice("タスクファイルが見つかりません");
        return;
      }
      
      // Update metadata
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          if (projectPath) {
            // If project is selected
            const projectFile = this.app.vault.getAbstractFileByPath(projectPath);
            if (projectFile) {
              // Save as plain text instead of link format to match existing format
              frontmatter.project = projectFile.basename;
              // Also save the path for faster lookup
              frontmatter.project_path = projectPath;
            }
          } else {
            // If no project is selected
            delete frontmatter.project;
            delete frontmatter.project_path; // For backward compatibility
          }
          return frontmatter;
        },
      );
      
      // Update task object
      if (projectPath) {
        const projectFile = this.app.vault.getAbstractFileByPath(projectPath);
        if (projectFile) {
          task.projectPath = projectPath;
          task.projectTitle = projectFile.basename;
        }
      } else {
        task.projectPath = null;
        task.projectTitle = null;
      }
      
      new Notice(`プロジェクト設定を保存しました`);
    } catch (error) {
      console.error("Failed to set project:", error);
      new Notice("プロジェクト設定に失敗しました");
    }
  }
  
  private updateProjectDisplay(inst: TaskInstance): void {
    // Find the task item
    const taskItem = this.taskList?.querySelector(
      `[data-task-path="${inst.task.path}"]`,
    ) as HTMLElement;
    
    if (taskItem) {
      const projectDisplay = taskItem.querySelector(
        ".taskchute-project-display",
      ) as HTMLElement;
      
      if (projectDisplay) {
        // Clear existing display
        projectDisplay.empty();
        
        if (inst.task.projectPath && inst.task.projectTitle) {
          // If project is set
          const projectButton = projectDisplay.createEl("span", {
            cls: "taskchute-project-button",
            attr: {
              title: `プロジェクト: ${inst.task.projectTitle}`,
            },
          });
          
          const folderIcon = projectButton.createEl("span", {
            cls: "taskchute-project-icon",
            text: "📁",
          });
          
          const projectName = projectButton.createEl("span", {
            cls: "taskchute-project-name",
            text: inst.task.projectTitle.replace(/^Project\s*-\s*/, ""),
          });
          
          projectButton.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.showUnifiedProjectModal(inst);
          });
          
          const externalLinkIcon = projectDisplay.createEl("span", {
            cls: "taskchute-external-link",
            text: "🔗",
            attr: { title: "プロジェクトノートを開く" },
          });
          
          externalLinkIcon.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.openProjectInSplit(inst.task.projectPath);
          });
        } else {
          // If project is not set
          const projectPlaceholder = projectDisplay.createEl("span", {
            cls: "taskchute-project-placeholder",
            attr: { title: "クリックしてプロジェクトを設定" },
          });
          
          projectPlaceholder.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.showProjectModal(inst);
          });
        }
      }
    }
  }
  
  private async openProjectInSplit(projectPath: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(projectPath);
      if (file instanceof TFile) {
        const leaf = this.app.workspace.getLeaf('split');
        await leaf.openFile(file);
      } else {
        new Notice(`プロジェクトファイルが見つかりません: ${projectPath}`);
      }
    } catch (error) {
      console.error("Failed to open project:", error);
      new Notice("プロジェクトファイルを開けませんでした");
    }
  }
  
  private async hasExecutionHistory(taskPath: string): Promise<boolean> {
    // 実行履歴の確認
    return false; // 仮実装
  }
  

  private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
    // Handle file rename logic (debug log removed)
  }

  private moveInstanceToSlot(fromSlot: string, fromIdx: number, toSlot: string, toIdx: number): void {
    // Handle moving task instances between slots (debug log removed)
  }

  // State management methods for deletion/hiding
  private getDeletedInstances(dateStr: string): DeletedInstance[] {
    const key = `taskchute-deleted-instances-${dateStr}`;
    try {
      const data = localStorage.getItem(key);
      if (!data) return [];
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }

  private saveDeletedInstances(dateStr: string, instances: DeletedInstance[]): void {
    const key = `taskchute-deleted-instances-${dateStr}`;
    try {
      localStorage.setItem(key, JSON.stringify(instances));
    } catch (e) {
      console.error("Failed to save deleted instances:", e);
    }
  }

  private getHiddenRoutines(dateStr: string): HiddenRoutine[] {
    const key = `taskchute-hidden-routines-${dateStr}`;
    try {
      const data = localStorage.getItem(key);
      if (!data) return [];
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }

  private saveHiddenRoutines(dateStr: string, routines: HiddenRoutine[]): void {
    const key = `taskchute-hidden-routines-${dateStr}`;
    try {
      localStorage.setItem(key, JSON.stringify(routines));
    } catch (e) {
      console.error("Failed to save hidden routines:", e);
    }
  }

  private isInstanceDeleted(instanceId: string, taskPath: string, dateStr: string): boolean {
    const deletedInstances = this.getDeletedInstances(dateStr);
    return deletedInstances.some((del) => {
      if (instanceId && del.instanceId === instanceId) return true;
      if (del.deletionType === "permanent" && del.path === taskPath) return true;
      return false;
    });
  }

  private isInstanceHidden(instanceId: string, taskPath: string, dateStr: string): boolean {
    const hiddenRoutines = this.getHiddenRoutines(dateStr);
    return hiddenRoutines.some((hidden) => {
      if (hidden.instanceId && hidden.instanceId === instanceId) return true;
      if (hidden.instanceId === null && hidden.path && hidden.path === taskPath) return true;
      return false;
    });
  }
}
