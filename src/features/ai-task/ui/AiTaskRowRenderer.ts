/**
 * AI Task - task row controls
 *
 * Renders the per-row AI settings button into the task name container of a
 * task list item. The robot opens the existing task's AI configuration;
 * execution remains owned by the row's primary play/stop control.
 * The controls must never become a direct child of .task-item: that element
 * is a grid with a fixed column template, so an extra direct child would
 * shift every subsequent column. Task rows are rebuilt on every task-list
 * render, so this renderer owns no subscription or persistent DOM state.
 */

import { setIcon } from 'obsidian'
import type { TaskInstance } from '../../../types'
import { readAiTaskConfig } from '../services/AiTaskFrontmatterReader'
import { readObsidianTaskLinkConfig } from '../services/ObsidianTaskLinkConfig'

export interface AiTaskRowRendererHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  isAiTaskFeatureEnabled: () => boolean
  editAiTask: (inst: TaskInstance) => void
}

export class AiTaskRowRenderer {
  constructor(private readonly host: AiTaskRowRendererHost) {}

  /** @param taskNameContainer the .task-name-container span of the row */
  render(taskNameContainer: HTMLElement, inst: TaskInstance): void {
    if (!this.host.isAiTaskFeatureEnabled()) return
    const config = readAiTaskConfig(inst.task.frontmatter)
    if (!config) return

    const container = taskNameContainer.createSpan({ cls: 'ai-task-controls' })
    if (readObsidianTaskLinkConfig(inst.task.frontmatter)) {
      this.renderObsidianLinkStatus(container)
    }
    this.renderEditButton(container, inst)
  }

  private renderObsidianLinkStatus(container: HTMLElement): void {
    const label = this.host.tv(
      'aiTask.obsidianLink.status',
      'Linked with Obsidian',
    )
    const icon = container.createSpan({
      cls: 'ai-task-obsidian-link-icon',
      attr: { 'aria-label': label, title: label },
    })
    setIcon(icon, 'link-2')
  }

  private renderEditButton(container: HTMLElement, inst: TaskInstance): void {
    const label = this.host.tv('aiTask.edit', 'Edit AI task')
    const button = container.createEl('button', {
      cls: 'ai-task-edit-button',
      text: '\u{1F916}',
      attr: { 'aria-label': label, title: label },
    })
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      this.host.editAiTask(inst)
    })
  }
}
