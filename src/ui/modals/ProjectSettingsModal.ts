import { App, ButtonComponent, Modal, Notice, Setting, TFile } from 'obsidian'
import { t } from '../../i18n'
import type { TaskChutePluginLike } from '../../types'

export interface ProjectSettingsModalOptions {
  app: App
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  plugin: TaskChutePluginLike
  displayTitle: string
  projectFiles: TFile[]
  currentProjectPath?: string | null
  onSubmit: (projectPath: string) => Promise<void>
}

export default class ProjectSettingsModal extends Modal {
  private selectedPath: string

  constructor(app: App, private readonly options: ProjectSettingsModalOptions) {
    super(app)
    this.selectedPath = options.currentProjectPath ?? ''
  }

  onOpen(): void {
    const { contentEl, options } = this
    const { tv } = options
    contentEl.empty()
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'taskchute-project-settings-modal')
    this.setTitle(
      tv('project.settingsTitle', `Project settings for "${options.displayTitle}"`, {
        title: options.displayTitle,
      }),
    )

    if (options.projectFiles.length === 0) {
      contentEl.createEl('p', {
        cls: 'form-description',
        text: tv('project.noFiles', 'No project files found in the configured folder.'),
      })
      const emptyButtons = contentEl.createDiv({ cls: 'modal-button-container' })
      new ButtonComponent(emptyButtons)
        .setButtonText(t('common.close', 'Close'))
        .onClick(() => this.close())
      return
    }

    new Setting(contentEl)
      .setName(tv('project.selectLabel', 'Select project:'))
      .addDropdown((dropdown) => {
        // With a project already assigned, the blank entry is how it gets
        // cleared; without one it is just the resting state.
        dropdown.addOption(
          '',
          options.currentProjectPath
            ? tv('buttons.removeProject', '➖ Remove project')
            : tv('project.none', 'No project'),
        )
        options.projectFiles.forEach((file) => {
          dropdown.addOption(file.path, this.getDisplayName(file.basename))
        })
        dropdown.setValue(this.selectedPath)
        dropdown.onChange((value) => {
          this.selectedPath = value
        })
      })

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' })
    const cancelButton = new ButtonComponent(buttons)
      .setButtonText(t('common.cancel', 'Cancel'))
      .onClick(() => this.close())
    const submitButton = new ButtonComponent(buttons)
      .setButtonText(tv('buttons.save', 'Save'))
      .setCta()
      .onClick(() => {
        void (async () => {
          submitButton.setDisabled(true)
          cancelButton.setDisabled(true)
          try {
            await options.onSubmit(this.selectedPath)
            this.close()
          } catch (error) {
            console.error('[ProjectSettingsModal] Failed to save project', error)
            new Notice(tv('notices.projectSetFailed', 'Failed to set project'))
            submitButton.setDisabled(false)
            cancelButton.setDisabled(false)
          }
        })()
      })
  }

  onClose(): void {
    this.contentEl.empty()
  }

  private getDisplayName(basename: string): string {
    const prefix = this.options.plugin.settings.projectTitlePrefix ?? ''
    if (prefix && basename.startsWith(prefix)) {
      return basename.slice(prefix.length).trimStart()
    }
    return basename
  }
}
