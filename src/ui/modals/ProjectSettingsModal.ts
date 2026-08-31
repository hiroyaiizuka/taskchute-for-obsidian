import { App, Modal, Notice, Setting, TFile } from 'obsidian'
import { t } from '../../i18n'
import { createModalFooter } from '../components/modalFooter'
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
      createModalFooter(contentEl, [
        { text: t('common.close', 'Close'), role: 'cancel', onClick: () => this.close() },
      ])
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

    // Both buttons go inert while the save is in flight.
    const busyButtons: HTMLButtonElement[] = []
    const collect = (button: HTMLButtonElement): void => {
      busyButtons.push(button)
    }
    const setBusy = (busy: boolean): void => {
      busyButtons.forEach((button) => {
        button.disabled = busy
      })
    }

    createModalFooter(contentEl, [
      {
        text: t('common.cancel', 'Cancel'),
        role: 'cancel',
        ref: collect,
        onClick: () => this.close(),
      },
      {
        text: tv('buttons.save', 'Save'),
        role: 'primary',
        ref: collect,
        onClick: () => {
          void (async () => {
            setBusy(true)
            try {
              await options.onSubmit(this.selectedPath)
              this.close()
            } catch (error) {
              console.error('[ProjectSettingsModal] Failed to save project', error)
              new Notice(tv('notices.projectSetFailed', 'Failed to set project'))
              setBusy(false)
            }
          })()
        },
      },
    ])
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
