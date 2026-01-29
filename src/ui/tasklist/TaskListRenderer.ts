import { TaskInstance } from '../../types'
import TaskItemActionController from './TaskItemActionController'
import TaskRowController from './TaskRowController'

export type TaskListRendererHost = {
  taskList: HTMLElement
  taskInstances: TaskInstance[]
  currentDate: Date
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: {
    workspace: {
      openLinkText: (path: string, sourcePath: string, newLeaf?: boolean) => Promise<void> | void
    }
  }
  applyResponsiveClasses: () => void
  sortTaskInstancesByTimeOrder: () => void
  getTimeSlotKeys: () => string[]
  sortByOrder: (instances: TaskInstance[]) => TaskInstance[]
  selectTaskForKeyboard: (inst: TaskInstance, element: HTMLElement) => void
  registerManagedDomEvent: (target: Document | HTMLElement, event: string, handler: EventListener) => void
  handleDragOver: (e: DragEvent, taskItem: HTMLElement, inst: TaskInstance) => void
  handleDrop: (e: DragEvent, taskItem: HTMLElement, inst: TaskInstance) => void
  handleSlotDrop: (e: DragEvent, slot: string) => void
  startInstance: (inst: TaskInstance) => Promise<void> | void
  stopInstance: (inst: TaskInstance) => Promise<void> | void
  duplicateAndStartInstance: (inst: TaskInstance) => Promise<void> | void
  showTaskCompletionModal: (inst: TaskInstance) => Promise<void> | void
  hasCommentData: (inst: TaskInstance) => Promise<boolean>
  showRoutineEditModal: (task: TaskInstance['task'], element: HTMLElement) => void
  toggleRoutine: (task: TaskInstance['task'], element?: HTMLElement) => Promise<void> | void
  showTaskSettingsTooltip: (inst: TaskInstance, element: HTMLElement) => void
  showTaskContextMenu: (e: MouseEvent, inst: TaskInstance) => void
  calculateCrossDayDuration: (start: Date, stop: Date) => number
  showStartTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
  showStopTimePopup: (inst: TaskInstance, anchor: HTMLElement) => void
  showReminderSettingsModal: (inst: TaskInstance) => void
  updateTotalTasksCount: () => void
  showProjectModal?: (inst: TaskInstance) => Promise<void> | void
  showUnifiedProjectModal?: (inst: TaskInstance) => Promise<void> | void
  openProjectInSplit?: (projectPath: string) => Promise<void> | void
}

export default class TaskListRenderer {
  private readonly actions: TaskItemActionController
  private readonly rowController: TaskRowController

  constructor(private readonly host: TaskListRendererHost) {
    const showProjectModalBound: ((inst: TaskInstance) => Promise<void> | void) | undefined = this.host.showProjectModal
      ? (this.host.showProjectModal.bind(this.host) as (inst: TaskInstance) => Promise<void> | void)
      : undefined
    const showUnifiedProjectModalBound: ((inst: TaskInstance) => Promise<void> | void) | undefined = this.host.showUnifiedProjectModal
      ? (this.host.showUnifiedProjectModal.bind(this.host) as (inst: TaskInstance) => Promise<void> | void)
      : undefined
    const openProjectInSplitBound: ((projectPath: string) => Promise<void> | void) | undefined = this.host.openProjectInSplit
      ? (this.host.openProjectInSplit.bind(this.host) as (projectPath: string) => Promise<void> | void)
      : undefined

    this.actions = new TaskItemActionController({
      tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
      app: this.host.app,
      registerManagedDomEvent: (target, event, handler) => this.host.registerManagedDomEvent(target, event, handler),
      showTaskCompletionModal: (inst) => this.host.showTaskCompletionModal(inst),
      hasCommentData: (inst) => this.host.hasCommentData(inst),
      showRoutineEditModal: (task, element) => this.host.showRoutineEditModal(task, element),
      toggleRoutine: (task, element) => this.host.toggleRoutine(task, element),
      showTaskSettingsTooltip: (inst, element) => this.host.showTaskSettingsTooltip(inst, element),
      showProjectModal: showProjectModalBound,
      showUnifiedProjectModal: showUnifiedProjectModalBound,
      openProjectInSplit: openProjectInSplitBound,
    })
    this.rowController = new TaskRowController({
      tv: (key, fallback, vars) => this.host.tv(key, fallback, vars),
      startInstance: (inst) => this.host.startInstance(inst),
      stopInstance: (inst) => this.host.stopInstance(inst),
      duplicateAndStartInstance: (inst) => this.host.duplicateAndStartInstance(inst),
      showStartTimePopup: (inst, anchor) => this.host.showStartTimePopup(inst, anchor),
      showStopTimePopup: (inst, anchor) => this.host.showStopTimePopup(inst, anchor),
      showReminderSettingsModal: (inst) => this.host.showReminderSettingsModal(inst),
      calculateCrossDayDuration: (start, stop) => this.host.calculateCrossDayDuration(start, stop),
      app: this.host.app,
    })
  }

  render(): void {
    const { taskList, taskInstances } = this.host
    const scrollTop = taskList.scrollTop
    const scrollLeft = taskList.scrollLeft

    this.host.applyResponsiveClasses()
    this.host.sortTaskInstancesByTimeOrder()
    taskList.empty()

    const timeSlots: Record<string, TaskInstance[]> = {}
    this.host.getTimeSlotKeys().forEach((slot) => {
      timeSlots[slot] = []
    })

    const noTimeInstances: TaskInstance[] = []
    taskInstances.forEach((inst) => {
      const slot = inst.slotKey && inst.slotKey !== 'none' ? inst.slotKey : null
      if (slot) {
        if (!timeSlots[slot]) {
          timeSlots[slot] = []
        }
        timeSlots[slot].push(inst)
      } else {
        noTimeInstances.push(inst)
      }
    })

    this.renderNoTimeGroup(noTimeInstances)
    this.host.getTimeSlotKeys().forEach((slot) => {
      this.renderTimeSlotGroup(slot, timeSlots[slot] || [])
    })

    taskList.scrollTop = scrollTop
    taskList.scrollLeft = scrollLeft
    this.host.updateTotalTasksCount()
  }

  updateTimerDisplay(timerEl: HTMLElement, inst: TaskInstance): void {
    this.rowController.updateTimerDisplay(timerEl, inst)
  }

  private renderNoTimeGroup(instances: TaskInstance[]): void {
    const header = this.host.taskList.createEl('div', {
      cls: 'time-slot-header other',
      text: this.host.tv('lists.noTime', 'No time'),
    })
    this.setupTimeSlotDragHandlers(header, 'none')
    this.host
      .sortByOrder(instances)
      .forEach((inst, idx) => this.createTaskInstanceItem(inst, 'none', idx))
  }

  private renderTimeSlotGroup(slot: string, instances: TaskInstance[]): void {
    const header = this.host.taskList.createEl('div', {
      cls: 'time-slot-header',
      text: slot,
    })
    this.setupTimeSlotDragHandlers(header, slot)
    this.host
      .sortByOrder(instances)
      .forEach((inst, idx) => this.createTaskInstanceItem(inst, slot, idx))
  }

  private createTaskInstanceItem(inst: TaskInstance, slot: string, idx: number): void {
    const taskItem = this.host.taskList.createEl('div', { cls: 'task-item' })
    if (inst.task.path) {
      taskItem.setAttribute('data-task-path', inst.task.path)
    }
    if (inst.instanceId) {
      taskItem.setAttribute('data-instance-id', inst.instanceId)
    }
    taskItem.setAttribute('data-slot', slot || 'none')

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const viewDate = new Date(this.host.currentDate)
    viewDate.setHours(0, 0, 0, 0)
    const isFutureTask = viewDate > today

    if (inst.state === 'done') {
      taskItem.classList.add('completed')
    }

    this.createDragHandle(taskItem, inst, slot, idx)
    this.rowController.renderPlayStopButton(taskItem, inst, isFutureTask)
    this.rowController.renderTaskName(taskItem, inst)
    this.actions.renderProject(taskItem, inst)
    this.rowController.renderTimeRangeDisplay(taskItem, inst)
    this.rowController.renderDurationDisplay(taskItem, inst)
    this.actions.renderCommentButton(taskItem, inst)
    this.actions.renderRoutineButton(taskItem, inst)
    this.actions.renderSettingsButton(taskItem, inst)
    this.setupTaskItemEventListeners(taskItem, inst)
  }

  private createDragHandle(taskItem: HTMLElement, inst: TaskInstance, slot: string, idx: number): void {
    const isDraggable = inst.state !== 'done'
    const dragHandle = taskItem.createEl('div', {
      cls: 'drag-handle',
      attr: isDraggable
        ? { draggable: 'true', title: this.host.tv('tooltips.dragToMove', 'Drag to move') }
        : { title: this.host.tv('tooltips.completedTask', 'Completed task') },
    })

    if (!isDraggable) {
      dragHandle.classList.add('disabled')
    }

    const svg = dragHandle.createSvg('svg', {
      attr: { viewBox: '0 0 12 16', width: '12', height: '16' },
      cls: 'drag-handle-icon',
    })
    const dots = [
      { cx: '2', cy: '2' },
      { cx: '8', cy: '2' },
      { cx: '2', cy: '8' },
      { cx: '8', cy: '8' },
      { cx: '2', cy: '14' },
      { cx: '8', cy: '14' },
    ]
    dots.forEach(({ cx, cy }) => {
      svg.createSvg('circle', { attr: { cx, cy, r: '1.5' } })
    })

    this.setupDragEvents(dragHandle, taskItem, slot, idx)
    dragHandle.addEventListener('click', (e) => {
      e.stopPropagation()
      this.host.selectTaskForKeyboard(inst, taskItem)
    })
  }

  private setupTaskItemEventListeners(taskItem: HTMLElement, inst: TaskInstance): void {
    this.host.registerManagedDomEvent(taskItem, 'contextmenu', (event) => {
      if (!(event instanceof MouseEvent)) return
      event.preventDefault()
      this.host.showTaskContextMenu(event, inst)
    })
    this.setupTaskItemDragDrop(taskItem, inst)
    this.host.registerManagedDomEvent(taskItem, 'click', (event) => {
      if (!(event instanceof MouseEvent)) return
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (target.closest('button, a, input, textarea, .drag-handle, [contenteditable="true"]')) {
        return
      }
      this.host.selectTaskForKeyboard(inst, taskItem)
    })
  }

  private setupTaskItemDragDrop(taskItem: HTMLElement, inst: TaskInstance): void {
    this.host.registerManagedDomEvent(taskItem, 'dragover', (event) => {
      if (!(event instanceof DragEvent)) return
      event.preventDefault()
      this.host.handleDragOver(event, taskItem, inst)
    })
    this.host.registerManagedDomEvent(taskItem, 'dragleave', () => {
      taskItem.classList.remove('dragover', 'dragover-top', 'dragover-bottom', 'dragover-invalid')
    })
    this.host.registerManagedDomEvent(taskItem, 'drop', (event) => {
      if (!(event instanceof DragEvent)) return
      event.preventDefault()
      this.host.handleDrop(event, taskItem, inst)
    })
  }

  private setupDragEvents(dragHandle: HTMLElement, taskItem: HTMLElement, slot: string, idx: number): void {
    this.host.registerManagedDomEvent(dragHandle, 'dragstart', (event) => {
      if (!(event instanceof DragEvent)) return
      event.dataTransfer?.setData('text/plain', `${slot ?? 'none'}::${idx}`)
      taskItem.classList.add('dragging')
    })
    this.host.registerManagedDomEvent(dragHandle, 'dragend', () => {
      taskItem.classList.remove('dragging')
    })
  }

  private setupTimeSlotDragHandlers(header: HTMLElement, slot: string): void {
    this.host.registerManagedDomEvent(header, 'dragover', (event) => {
      if (!(event instanceof DragEvent)) return
      event.preventDefault()
      header.classList.add('dragover')
    })
    this.host.registerManagedDomEvent(header, 'dragleave', () => {
      header.classList.remove('dragover')
    })
    this.host.registerManagedDomEvent(header, 'drop', (event) => {
      if (!(event instanceof DragEvent)) return
      event.preventDefault()
      header.classList.remove('dragover')
      this.host.handleSlotDrop(event, slot)
    })
  }
}
