import { App, Notice, Platform, SuggestModal, TFile } from 'obsidian'
import { t, type ScopedTranslator } from '@/i18n'
import type { TaskChutePluginLike } from '@/types'
import { projectChoices, type ProjectChoice } from '../project/projectChoices'

export interface ProjectPickerModalOptions {
  tv: ScopedTranslator<'taskChuteView'>
  plugin: TaskChutePluginLike
  displayTitle: string
  projectFiles: TFile[]
  currentProjectPath?: string | null
  /** Links the task to this project; an empty path removes the link. */
  onSubmit: (projectPath: string) => Promise<void>
  /** Creates a project note (status todo) and resolves to its path. */
  createProject: (title: string) => Promise<string>
}

/**
 * A task's project, picked like Obsidian's quick switcher: type to narrow,
 * Enter or a tap decides. A name no project has is created and linked in
 * the same step. One modal, nothing stacked on it; closing it changes nothing.
 */
export default class ProjectPickerModal extends SuggestModal<ProjectChoice> {
  constructor(app: App, private readonly options: ProjectPickerModalOptions) {
    super(app)
    const { tv } = options
    this.modalEl.addClass('taskchute-project-picker')
    this.setPlaceholder(
      tv('project.pickerPlaceholder', 'Find or create a project for "{title}"', {
        title: options.displayTitle,
      }),
    )
    this.emptyStateText = tv('project.pickerEmpty', 'No projects yet. Type a name to create one.')
    // Phones have no Esc and no arrow keys: Obsidian shows its own cancel there.
    if (!Platform.isMobile) {
      this.setInstructions([
        { command: '↑↓', purpose: tv('project.pickerMove', 'Move') },
        { command: '↵', purpose: tv('project.pickerChoose', 'Choose') },
        { command: 'esc', purpose: tv('project.pickerClose', 'Close without changes') },
      ])
    }
  }

  getSuggestions(query: string): ProjectChoice[] {
    const projects = this.options.projectFiles.map((file) => ({
      path: file.path,
      name: this.getDisplayName(file.basename),
    }))
    return projectChoices(query, projects, this.options.currentProjectPath)
  }

  renderSuggestion(choice: ProjectChoice, el: HTMLElement): void {
    const { tv } = this.options
    el.addClass('taskchute-project-picker__choice')
    if (choice.kind === 'create') {
      el.addClass('is-create')
      el.setText(tv('project.pickerCreate', 'Create "{title}"', { title: choice.title }))
    } else if (choice.kind === 'remove') {
      el.setText(tv('buttons.removeProject', '➖ Remove project'))
    } else {
      el.createSpan({ text: choice.name })
      if (choice.current) {
        el.createSpan({ cls: 'taskchute-project-picker__current', text: '✓' })
      }
    }
  }

  onChooseSuggestion(choice: ProjectChoice): void {
    void this.apply(choice)
  }

  private async apply(choice: ProjectChoice): Promise<void> {
    const { options } = this
    if (choice.kind === 'project' && choice.current) return
    let projectPath = ''
    if (choice.kind === 'create') {
      try {
        projectPath = await options.createProject(choice.title)
      } catch (error) {
        console.error('[ProjectPickerModal] Failed to create project', error)
        new Notice(t('projectCreate.error', 'Failed to create project'))
        return
      }
    } else if (choice.kind === 'project') {
      projectPath = choice.path
    }
    try {
      await options.onSubmit(projectPath)
    } catch (error) {
      console.error('[ProjectPickerModal] Failed to set project', error)
      new Notice(options.tv('notices.projectSetFailed', 'Failed to set project'))
    }
  }

  private getDisplayName(basename: string): string {
    const prefix = this.options.plugin.settings.projectTitlePrefix ?? ''
    if (prefix && basename.startsWith(prefix)) {
      return basename.slice(prefix.length).trimStart()
    }
    return basename
  }
}
