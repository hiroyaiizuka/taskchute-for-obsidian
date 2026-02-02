import { Notice, TFile } from 'obsidian'
import { t } from '../../i18n'
import type { TaskChutePluginLike } from '../../types'
import { attachCloseButtonIcon } from '../components/iconUtils'

export interface ProjectSettingsModalOptions {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  plugin: TaskChutePluginLike
  displayTitle: string
  projectFiles: TFile[]
  currentProjectPath?: string | null
  onSubmit: (projectPath: string) => Promise<void>
  context?: {
    doc?: Document
    win?: Window & typeof globalThis
  }
}

export interface ProjectSettingsModalHandle {
  overlay: HTMLElement
  close: () => void
}

export function createProjectSettingsModal(options: ProjectSettingsModalOptions): ProjectSettingsModalHandle {
  const doc = options.context?.doc ?? document
  const tv = options.tv

  const overlay = doc.createElement('div')
  overlay.className = 'task-modal-overlay'

  const content = doc.createElement('div')
  content.className = 'task-modal-content project-settings-modal-content'
  overlay.appendChild(content)

  // Header
  const header = doc.createElement('div')
  header.className = 'modal-header'
  content.appendChild(header)

  const title = doc.createElement('h3')
  title.textContent = tv(
    'project.settingsTitle',
    `Project settings for "${options.displayTitle}"`,
    { title: options.displayTitle },
  )
  header.appendChild(title)

  const closeButton = doc.createElement('button')
  closeButton.className = 'modal-close-button'
  closeButton.setAttribute('aria-label', t('common.close', 'Close'))
  closeButton.setAttribute('title', t('common.close', 'Close'))
  closeButton.setAttribute('type', 'button')
  attachCloseButtonIcon(closeButton)
  header.appendChild(closeButton)

  // Body
  const body = doc.createElement('div')
  body.className = 'project-settings-body'
  content.appendChild(body)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    if (overlay.parentElement) {
      overlay.parentElement.removeChild(overlay)
    }
  }

  closeButton.addEventListener('click', close)

  // Empty state
  if (options.projectFiles.length === 0) {
    const emptyMessage = doc.createElement('p')
    emptyMessage.className = 'form-description'
    emptyMessage.textContent = tv('project.noFiles', 'No project files found in the configured folder.')
    body.appendChild(emptyMessage)

    const footer = doc.createElement('div')
    footer.className = 'form-button-group project-settings-actions'
    body.appendChild(footer)

    const cancelButton = doc.createElement('button')
    cancelButton.type = 'button'
    cancelButton.className = 'form-button cancel'
    cancelButton.textContent = t('common.close', 'Close')
    cancelButton.addEventListener('click', close)
    footer.appendChild(cancelButton)

    doc.body.appendChild(overlay)
    return { overlay, close }
  }

  // Form
  const form = doc.createElement('form')
  form.className = 'task-form project-settings-form'
  body.appendChild(form)

  const selectGroup = doc.createElement('div')
  selectGroup.className = 'form-group project-select-group'
  form.appendChild(selectGroup)

  const projectSelect = doc.createElement('select')
  projectSelect.className = 'form-input'
  projectSelect.setAttribute('aria-label', tv('project.selectLabel', 'Select project:'))
  selectGroup.appendChild(projectSelect)

  // Options
  if (options.currentProjectPath) {
    const removeOption = doc.createElement('option')
    removeOption.value = ''
    removeOption.textContent = tv('buttons.removeProject', '➖ Remove project')
    projectSelect.appendChild(removeOption)
  } else {
    const noneOption = doc.createElement('option')
    noneOption.value = ''
    noneOption.textContent = tv('project.none', 'No project')
    noneOption.selected = true
    projectSelect.appendChild(noneOption)
  }

  const getDisplayName = (basename: string): string => {
    const prefix = options.plugin.settings.projectTitlePrefix ?? ''
    if (prefix && basename.startsWith(prefix)) {
      return basename.slice(prefix.length).trimStart()
    }
    return basename
  }

  options.projectFiles.forEach((file) => {
    const option = doc.createElement('option')
    option.value = file.path
    option.textContent = getDisplayName(file.basename)
    if (file.path === options.currentProjectPath) {
      option.selected = true
    }
    projectSelect.appendChild(option)
  })

  // Buttons
  const footer = doc.createElement('div')
  footer.className = 'form-button-group project-settings-actions'
  form.appendChild(footer)

  const cancelButton = doc.createElement('button')
  cancelButton.type = 'button'
  cancelButton.className = 'form-button cancel'
  cancelButton.textContent = t('common.cancel', 'Cancel')
  cancelButton.addEventListener('click', close)
  footer.appendChild(cancelButton)

  const submitButton = doc.createElement('button')
  submitButton.type = 'submit'
  submitButton.className = 'form-button create'
  submitButton.textContent = tv('buttons.save', 'Save')
  footer.appendChild(submitButton)

  form.addEventListener('submit', (event) => {
    void (async () => {
      event.preventDefault()
      submitButton.disabled = true
      cancelButton.disabled = true
      try {
        await options.onSubmit(projectSelect.value)
        close()
      } catch (error) {
        console.error('[ProjectSettingsModal] Failed to save project', error)
        new Notice(tv('notices.projectSetFailed', 'Failed to set project'))
        submitButton.disabled = false
        cancelButton.disabled = false
      }
    })()
  })

  doc.body.appendChild(overlay)

  return { overlay, close }
}

// Legacy class for backward compatibility
export default class ProjectSettingsModal {
  private handle: ProjectSettingsModalHandle | null = null

  constructor(
    _app: unknown,
    private readonly options: {
      app: unknown
      plugin: TaskChutePluginLike
      tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
      displayTitle: string
      projectFiles: TFile[]
      currentProjectPath?: string | null
      onSubmit: (projectPath: string) => Promise<void>
    },
  ) {}

  open(): void {
    this.handle = createProjectSettingsModal({
      tv: this.options.tv,
      plugin: this.options.plugin,
      displayTitle: this.options.displayTitle,
      projectFiles: this.options.projectFiles,
      currentProjectPath: this.options.currentProjectPath,
      onSubmit: this.options.onSubmit,
    })
  }

  close(): void {
    this.handle?.close()
    this.handle = null
  }

  // For test compatibility
  get contentEl(): HTMLElement & { children: HTMLElement[]; empty: () => void; classList: DOMTokenList; createEl: (tag: string, options?: { cls?: string; text?: string }) => HTMLElement } {
    const el = this.handle?.overlay.querySelector('.task-modal-content') as HTMLElement
    return el as HTMLElement & { children: HTMLElement[]; empty: () => void; classList: DOMTokenList; createEl: (tag: string, options?: { cls?: string; text?: string }) => HTMLElement }
  }

  onOpen(): void {
    // Called for test compatibility - actual open is done in open()
    this.open()
  }

  onClose(): void {
    // No-op for compatibility
  }
}
