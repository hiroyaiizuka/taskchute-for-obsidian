/**
 * AI Task - task row controls
 *
 * Renders the per-row AI run button into the task name container of a task
 * list item. The button deliberately keeps the same robot appearance while
 * a run is active: the task row's primary play/stop control already conveys
 * execution state and owns the coupled stop action.
 * The controls must never become a direct child of .task-item: that element
 * is a grid with a fixed column template, so an extra direct child would
 * shift every subsequent column. Task rows are rebuilt on every task-list
 * render, so this renderer owns no subscription or persistent DOM state.
 */

import type { TaskInstance } from '../../../types'
import { readAiTaskConfig } from '../services/AiTaskFrontmatterReader'

export interface AiTaskRowRendererHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  isAiTaskFeatureEnabled: () => boolean
  startAiRun: (inst: TaskInstance) => void
}

export class AiTaskRowRenderer {
  constructor(private readonly host: AiTaskRowRendererHost) {}

  /** @param taskNameContainer the .task-name-container span of the row */
  render(taskNameContainer: HTMLElement, inst: TaskInstance): void {
    if (!this.host.isAiTaskFeatureEnabled()) return
    const config = readAiTaskConfig(inst.task.frontmatter)
    if (!config) return

    const container = taskNameContainer.createSpan({ cls: 'ai-task-controls' })
    this.renderRunButton(container, inst)
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
}
