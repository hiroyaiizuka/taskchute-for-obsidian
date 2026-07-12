/**
 * AI Task - task row controls
 *
 * Renders the per-row AI controls (run button, or stop control + status chip
 * while a run is active) into the task name container of a task list item.
 * The controls must never become a direct child of .task-item: that element
 * is a grid with a fixed column template, so an extra direct child would
 * shift every subsequent column. State is pull-based: the renderer reads the
 * active run at render time and never subscribes, because task rows are
 * rebuilt on every task list re-render.
 *
 * When a task note has duplicated rows, the status chip + stop control
 * render ONLY on the row that owns the run: the row whose inst.instanceId
 * matches record.instanceId, or — for legacy runs without an instanceId —
 * the host-resolved primary (first) instance of the task path. Every other
 * row keeps the plain run button.
 */

import type { TaskInstance } from '../../../types'
import type { AiRunRecord, AiRunStatus } from '../types'
import { readAiTaskConfig } from '../services/AiTaskFrontmatterReader'

export interface AiTaskRowRendererHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  isAiTaskFeatureEnabled: () => boolean
  getActiveAiRun: (taskPath: string) => AiRunRecord | undefined
  startAiRun: (inst: TaskInstance) => void
  stopAiRun: (runId: string) => void
  /**
   * Fallback run-ownership resolution for runs without an instanceId: true
   * when inst is the first rendered instance of its task path. Optional for
   * backward compatibility; when absent every row of the path shows the
   * chip (legacy behavior).
   */
  isPrimaryInstance?: (inst: TaskInstance) => boolean
}

const STATUS_FALLBACK_LABELS: Record<AiRunStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  succeeded: 'Succeeded',
  failed: 'Failed',
  stopped: 'Stopped',
}

export class AiTaskRowRenderer {
  constructor(private readonly host: AiTaskRowRendererHost) {}

  /** @param taskNameContainer the .task-name-container span of the row */
  render(taskNameContainer: HTMLElement, inst: TaskInstance): void {
    if (!this.host.isAiTaskFeatureEnabled()) return
    const config = readAiTaskConfig(inst.task.frontmatter)
    if (!config) return

    const container = taskNameContainer.createSpan({ cls: 'ai-task-controls' })
    const activeRun = inst.task.path
      ? this.host.getActiveAiRun(inst.task.path)
      : undefined

    if (activeRun && this.ownsRun(activeRun, inst)) {
      this.renderStopControl(container, activeRun)
      this.renderStatusChip(container, activeRun.status)
    } else {
      this.renderRunButton(container, inst)
    }
  }

  /** Whether this row's instance is the one the active run belongs to */
  private ownsRun(run: AiRunRecord, inst: TaskInstance): boolean {
    if (typeof run.instanceId === 'string' && run.instanceId.length > 0) {
      return run.instanceId === inst.instanceId
    }
    return this.host.isPrimaryInstance?.(inst) ?? true
  }

  private renderRunButton(container: HTMLElement, inst: TaskInstance): void {
    const label = this.host.tv('aiTask.run', 'Run AI task')
    const button = container.createEl('button', {
      cls: 'ai-task-run-button',
      text: '\u{1F916}',
      attr: { 'aria-label': label, title: label },
    })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.host.startAiRun(inst)
    })
  }

  private renderStopControl(container: HTMLElement, run: AiRunRecord): void {
    const label = this.host.tv('aiTask.stop', 'Stop AI task')
    const button = container.createEl('button', {
      cls: 'ai-task-run-button ai-task-run-button--stop',
      text: '⏹',
      attr: { 'aria-label': label, title: label },
    })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.host.stopAiRun(run.id)
    })
  }

  private renderStatusChip(container: HTMLElement, status: AiRunStatus): void {
    container.createSpan({
      cls: `ai-task-status-chip ai-task-status-chip--${status}`,
      text: this.host.tv(
        `aiTask.status.${status}`,
        STATUS_FALLBACK_LABELS[status],
      ),
    })
  }
}
