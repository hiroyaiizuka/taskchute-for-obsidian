import { Notice } from 'obsidian'
import { TaskInstance } from '../../types'
import type { DragPointer } from './TaskListPointerDrag'

/**
 * What the placement math reads off the event. The list drags on Pointer
 * Events now, so the controller takes coordinates plus an explicit payload;
 * a `DragEvent` still satisfies the shape, which is what keeps the project
 * board's native drag path on the same code.
 */
type DragSource = DragPointer & {
  dataTransfer?: { getData: (format: string) => string } | null
}

export interface TaskDragControllerHost {
  getTaskInstances: () => TaskInstance[]
  sortByOrder: (instances: TaskInstance[]) => TaskInstance[]
  getStatePriority: (state: TaskInstance['state']) => number
  normalizeState: (state: TaskInstance['state']) => string
  moveTaskToSlot: (inst: TaskInstance, slot: string, stateInsertIndex?: number) => Promise<void> | void
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
}

/**
 * Parsed dragstart payload: `slot::idx[::instanceId]`. The instanceId (added
 * for board-view filtering, where idx counts FILTERED rows) is the preferred
 * way to resolve the dragged instance; slot+idx remain as the positional
 * fallback for id-less payloads.
 */
interface DragPayload {
  sourceSlot: string
  sourceIndex: number
  instanceId?: string
}

export default class TaskDragController {
  constructor(private readonly host: TaskDragControllerHost) {}

  handleDragOver(e: DragSource, taskItem: HTMLElement, inst: TaskInstance): void {
    this.clearDragoverClasses(taskItem)

    if (inst.state === 'done') {
      taskItem.dataset.dragInvalidMessage = this.host.tv(
        'notices.dropNotAllowedHere',
        'Cannot drop here',
      )
      taskItem.classList.add('dragover-invalid')
      return
    }

    const rect = taskItem.getBoundingClientRect()
    const y = e.clientY - rect.top
    const isBottomHalf = y > rect.height / 2
    taskItem.classList.add(isBottomHalf ? 'dragover-bottom' : 'dragover-top')
  }

  handleDrop(
    e: DragSource,
    taskItem: HTMLElement,
    targetInst: TaskInstance,
    payloadOverride?: string,
  ): void {
    const data = payloadOverride ?? e.dataTransfer?.getData('text/plain')
    if (!data) {
      this.clearDragoverClasses(taskItem)
      return
    }

    const payload = this.parseDragPayload(data)
    if (!payload) {
      this.clearDragoverClasses(taskItem)
      return
    }

    const taskInstances = this.host.getTaskInstances()
    const targetSlot = targetInst.slotKey || 'none'
    const sourceInst = this.findSourceInstance(taskInstances, payload)
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

    if (payload.sourceSlot === targetSlot) {
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

  handleSlotDrop(e: DragSource, slot: string, payloadOverride?: string): void {
    const data = payloadOverride ?? e.dataTransfer?.getData('text/plain')
    if (!data) return

    const payload = this.parseDragPayload(data)
    if (!payload) return

    const normalizedSlot = slot || 'none'
    const taskInstances = this.host.getTaskInstances()
    const sourceInst = this.findSourceInstance(taskInstances, payload)
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
    delete taskItem.dataset.dragInvalidMessage
  }

  private parseDragPayload(data: string): DragPayload | null {
    const [slotRaw, sourceIdxRaw, ...idParts] = data.split('::')
    const sourceIndex = Number.parseInt(sourceIdxRaw ?? '', 10)
    if (Number.isNaN(sourceIndex)) return null
    const instanceId = idParts.length > 0 ? idParts.join('::') : undefined
    return {
      sourceSlot: slotRaw || 'none',
      sourceIndex,
      instanceId: instanceId !== undefined && instanceId.length > 0 ? instanceId : undefined,
    }
  }

  private findSourceInstance(
    taskInstances: TaskInstance[],
    payload: DragPayload,
  ): TaskInstance | undefined {
    if (payload.instanceId !== undefined) {
      // Identity beats position: the payload index counts FILTERED rows
      // (board view), so it can point at a different task in the unfiltered
      // list. An id that no longer exists (stale drag across a reload)
      // resolves to nothing rather than to the wrong task.
      return taskInstances.find((inst) => inst.instanceId === payload.instanceId)
    }
    const slotInstances = taskInstances.filter(
      (inst) => (inst.slotKey || 'none') === payload.sourceSlot,
    )
    const sorted = this.host.sortByOrder(slotInstances)
    return sorted[payload.sourceIndex]
  }
}
