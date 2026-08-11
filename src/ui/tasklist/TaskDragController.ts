import { Notice } from 'obsidian'
import { TaskInstance } from '../../types'

export interface TaskDragControllerHost {
  getTaskInstances: () => TaskInstance[]
  sortByOrder: (instances: TaskInstance[]) => TaskInstance[]
  getStatePriority: (state: TaskInstance['state']) => number
  normalizeState: (state: TaskInstance['state']) => string
  moveTaskToSlot: (inst: TaskInstance, slot: string, stateInsertIndex?: number) => Promise<void> | void
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
}

export default class TaskDragController {
  constructor(private readonly host: TaskDragControllerHost) {}

  handleDragOver(e: DragEvent, taskItem: HTMLElement, inst: TaskInstance): void {
    e.preventDefault()
    this.clearDragoverClasses(taskItem)

    if (inst.state === 'done') {
      taskItem.classList.add('dragover-invalid')
      return
    }

    const rect = taskItem.getBoundingClientRect()
    const y = e.clientY - rect.top
    const isBottomHalf = y > rect.height / 2
    taskItem.classList.add(isBottomHalf ? 'dragover-bottom' : 'dragover-top')
  }

  handleDrop(e: DragEvent, taskItem: HTMLElement, targetInst: TaskInstance): void {
    const data = e.dataTransfer?.getData('text/plain')
    if (!data) {
      this.clearDragoverClasses(taskItem)
      return
    }

    const [sourceSlot, sourceIdxRaw] = data.split('::')
    const sourceIndex = Number.parseInt(sourceIdxRaw ?? '', 10)
    if (Number.isNaN(sourceIndex)) {
      this.clearDragoverClasses(taskItem)
      return
    }

    const taskInstances = this.host.getTaskInstances()
    const targetSlot = targetInst.slotKey || 'none'
    const sourceInst = this.findSourceInstance(taskInstances, sourceSlot || 'none', sourceIndex)
    if (!sourceInst || sourceInst.state === 'done') {
      this.clearDragoverClasses(taskItem)
      return
    }

    const rect = taskItem.getBoundingClientRect()
    const isBottomHalf = e.clientY - rect.top > rect.height / 2

    const sortedTargetTasks = this.host.sortByOrder(
      taskInstances.filter((candidate) => (candidate.slotKey || 'none') === targetSlot),
    )
    const filteredTargetTasks = sortedTargetTasks.filter((candidate) => candidate !== sourceInst)

    const targetIndex = sortedTargetTasks.indexOf(targetInst)
    let newPosition = isBottomHalf ? targetIndex + 1 : targetIndex

    const sourcePriority = this.host.getStatePriority(sourceInst.state)
    const minAllowed = sortedTargetTasks.reduce((count, candidate) => {
      return this.host.getStatePriority(candidate.state) < sourcePriority ? count + 1 : count
    }, 0)

    let boundaryAfter = sortedTargetTasks.length
    for (let i = 0; i < sortedTargetTasks.length; i += 1) {
      if (this.host.getStatePriority(sortedTargetTasks[i].state) > sourcePriority) {
        boundaryAfter = i
        break
      }
    }

    if (newPosition < minAllowed) {
      new Notice(
        this.host.tv(
          'notices.cannotPlaceAboveCompleted',
          'Cannot place above running or completed tasks',
        ),
      )
      this.clearDragoverClasses(taskItem)
      return
    }

    if (newPosition > boundaryAfter) {
      newPosition = boundaryAfter
    }

    if ((sourceSlot || 'none') === targetSlot) {
      const inTargetIndex = sortedTargetTasks.indexOf(sourceInst)
      if (inTargetIndex < newPosition) {
        newPosition -= 1
      }
    }

    const clampedPosition = Math.max(0, Math.min(newPosition, filteredTargetTasks.length))
    const normalizedSourceState = this.host.normalizeState(sourceInst.state)
    let stateInsertIndex = 0
    for (let i = 0; i < clampedPosition; i += 1) {
      const candidate = filteredTargetTasks[i]
      if (this.host.normalizeState(candidate.state) === normalizedSourceState) {
        stateInsertIndex += 1
      }
    }

    void Promise.resolve(this.host.moveTaskToSlot(sourceInst, targetSlot, stateInsertIndex)).catch(
      (error) => {
        console.error('[TaskChute]', 'moveTaskToSlot failed', error)
        new Notice(
          this.host.tv('notices.taskMoveFailed', 'Failed to move task'),
        )
      },
    )
    this.clearDragoverClasses(taskItem)
  }

  handleSlotDrop(e: DragEvent, slot: string): void {
    const data = e.dataTransfer?.getData('text/plain')
    if (!data) return

    const [sourceSlot, sourceIdxRaw] = data.split('::')
    const sourceIndex = Number.parseInt(sourceIdxRaw ?? '', 10)
    if (Number.isNaN(sourceIndex)) return

    const normalizedSlot = slot || 'none'
    const taskInstances = this.host.getTaskInstances()
    const sourceInst = this.findSourceInstance(taskInstances, sourceSlot || 'none', sourceIndex)
    if (!sourceInst || sourceInst.state === 'done') return

    const normalizedState = this.host.normalizeState(sourceInst.state)
    const sameStateTasks = taskInstances.filter(
      (candidate) =>
        candidate !== sourceInst &&
        (candidate.slotKey || 'none') === normalizedSlot &&
        this.host.normalizeState(candidate.state) === normalizedState,
    )
    const insertIndex = sameStateTasks.length
    void Promise.resolve(this.host.moveTaskToSlot(sourceInst, slot, insertIndex)).catch(
      (error) => {
        console.error('[TaskChute]', 'moveTaskToSlot end-of-slot failed', error)
        new Notice(this.host.tv('notices.taskMoveFailed', 'Failed to move task'))
      },
    )
  }

  clearDragoverClasses(taskItem: HTMLElement): void {
    taskItem.classList.remove(
      'dragover',
      'dragover-top',
      'dragover-bottom',
      'dragover-invalid',
    )
  }

  private findSourceInstance(
    taskInstances: TaskInstance[],
    sourceSlot: string,
    targetIndex: number,
  ): TaskInstance | undefined {
    const slotInstances = taskInstances.filter((inst) => (inst.slotKey || 'none') === sourceSlot)
    const sorted = this.host.sortByOrder(slotInstances)
    return sorted[targetIndex]
  }
}
