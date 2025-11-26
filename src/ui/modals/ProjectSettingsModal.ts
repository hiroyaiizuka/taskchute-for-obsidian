import { App, Modal, Notice, TFile } from 'obsidian'
import { t } from '../../i18n'
import type { TaskChutePluginLike } from '../../types'

export interface ProjectSettingsModalOptions {
  app: App
  plugin: TaskChutePluginLike
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  displayTitle: string
  projectFiles: TFile[]
  currentProjectPath?: string | null
  onSubmit: (projectPath: string) => Promise<void>
}

export default class ProjectSettingsModal extends Modal {
  private readonly plugin: TaskChutePluginLike
  private readonly tv: ProjectSettingsModalOptions['tv']
  private readonly displayTitle: string
  private readonly projectFiles: TFile[]
  private readonly currentProjectPath?: string | null
  private readonly onSubmit: (projectPath: string) => Promise<void>

  constructor(app: App, options: ProjectSettingsModalOptions) {
    super(app)
    this.plugin = options.plugin
    this.tv = options.tv
    this.displayTitle = options.displayTitle
    this.projectFiles = options.projectFiles
    this.currentProjectPath = options.currentProjectPath
    this.onSubmit = options.onSubmit
  }

  onOpen(): void {
    const { contentEl } = this
    contentEl.empty()
    contentEl.classList.add('project-settings-modal-content')

    const header = contentEl.createEl('div', { cls: 'modal-header' })
    header.createEl('h3', {
      text: this.tv(
        'project.settingsTitle',
        `Project settings for "${this.displayTitle}"`,
        { title: this.displayTitle },
      ),
    })


    const body = contentEl.createEl('div', { cls: 'project-settings-body' })

    if (this.projectFiles.length === 0) {
      body.createEl('p', {
        text: this.tv('project.noFiles', 'No project files found in the configured folder.'),
        cls: 'form-description',
      })
      const footer = this.renderFooter(contentEl)
      const cancel = footer.querySelector('.form-button.cancel') as HTMLButtonElement
      cancel.textContent = t('common.close', 'Close')
      // rely on default modal close button
      cancel.addEventListener('click', () => this.close())
      return
    }

    const form = body.createEl('form', { cls: 'task-form project-settings-form' })

    const selectGroup = form.createEl('div', { cls: 'form-group project-select-group' })
    const projectSelect = selectGroup.createEl('select', { cls: 'form-input' })
    projectSelect.setAttr('aria-label', this.tv('project.selectLabel', 'Select project:'))

    // Remove/None option
    if (this.currentProjectPath) {
      projectSelect.createEl('option', {
        value: '',
        text: this.tv('buttons.removeProject', '➖ Remove project'),
      })
    } else {
      const noneOption = projectSelect.createEl('option', {
        value: '',
        text: this.tv('project.none', 'No project'),
      })
      noneOption.selected = true
    }

    this.projectFiles.forEach((file) => {
      const option = projectSelect.createEl('option', {
        value: file.path,
        text: this.getDisplayName(file.basename),
      })
      if (file.path === this.currentProjectPath) {
        option.selected = true
      }
    })

    const descriptionGroup = form.createEl('div', { cls: 'form-group' })
    descriptionGroup.createEl('p', {
      text: this.currentProjectPath
        ? this.tv(
            'project.instructionsLinked',
            'Select another project or choose "Remove project" to clear the assignment.',
          )
        : this.tv(
            'project.instructionsUnlinked',
            'Assigning a project lets you review related tasks from the project page.',
          ),
      cls: 'form-description',
    })

    const footer = this.renderFooter(form)
    const cancelButton = footer.querySelector('.form-button.cancel') as HTMLButtonElement
    const submitButton = footer.querySelector('.form-button.create') as HTMLButtonElement

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      submitButton.disabled = true
      cancelButton.disabled = true
      try {
        await this.onSubmit(projectSelect.value)
        this.close()
      } catch (error) {
        console.error('[ProjectSettingsModal] Failed to save project', error)
        new Notice(this.tv('notices.projectSetFailed', 'Failed to set project'))
        submitButton.disabled = false
        cancelButton.disabled = false
      }
    })

    cancelButton.addEventListener('click', () => this.close())
  }

  onClose(): void {
    this.contentEl.empty()
    this.contentEl.classList.remove('project-settings-modal-content')
  }

  private renderFooter(parent: HTMLElement): HTMLElement {
    const footer = parent.createEl('div', { cls: 'form-button-group project-settings-actions' })
    footer.createEl('button', {
      type: 'button',
      cls: 'form-button cancel',
      text: t('common.cancel', 'Cancel'),
    })
    footer.createEl('button', {
      type: 'submit',
      cls: 'form-button create',
      text: this.tv('buttons.save', 'Save'),
    })
    return footer
  }

  private getDisplayName(basename: string): string {
    const prefix = this.plugin.settings.projectTitlePrefix ?? ''
    if (prefix && basename.startsWith(prefix)) {
      return basename.slice(prefix.length).trimStart()
    }
    return basename
  }
}
