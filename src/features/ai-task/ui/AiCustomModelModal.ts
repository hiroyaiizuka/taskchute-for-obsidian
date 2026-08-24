import { setIcon } from 'obsidian'
import type {
  AiCustomModel,
  AiCustomModelMutationError,
  AiCustomModelStore,
} from '../models/AiCustomModelStore'
import type { AiTaskHost } from '../types'

export interface AiCustomModelModalLabels {
  addTitle: string
  editTitle: string
  claudeAgent: string
  codexAgent: string
  modelId: string
  modelIdPlaceholder: string
  modelIdHelp: string
  displayName: string
  displayNamePlaceholder: string
  description: string
  descriptionPlaceholder: string
  commandPreview: string
  cancel: string
  add: string
  save: string
  close: string
  invalidId: string
  duplicateId: string
  invalidLabel: string
  invalidDescription: string
  modelNotFound: string
}

export interface AiCustomModelModalOptions {
  doc?: Document
  host: AiTaskHost
  store: AiCustomModelStore
  editModel?: AiCustomModel
  labels?: Partial<AiCustomModelModalLabels>
  onSaved?: (model: AiCustomModel) => void
  onClosed?: () => void
}

const DEFAULT_LABELS: AiCustomModelModalLabels = {
  addTitle: 'Add custom model',
  editTitle: 'Edit custom model',
  claudeAgent: 'Claude Code',
  codexAgent: 'Codex',
  modelId: 'Model ID',
  modelIdPlaceholder: 'provider/model-name',
  modelIdHelp: 'The model ID passed to the CLI',
  displayName: 'Display name',
  displayNamePlaceholder: 'My custom model',
  description: 'Description',
  descriptionPlaceholder: 'Optional description',
  commandPreview: 'Command preview',
  cancel: 'Cancel',
  add: 'Add',
  save: 'Save',
  close: 'Close',
  invalidId: 'Enter a safe model ID.',
  duplicateId: 'This model ID already exists.',
  invalidLabel: 'Enter a display name.',
  invalidDescription: 'The description is invalid.',
  modelNotFound: 'The custom model no longer exists.',
}

let modalSequence = 0

/**
 * Device-local custom-model editor shared by every AI-model picker.
 *
 * Model IDs are editable only while adding. Editing intentionally keeps the
 * ID fixed because task notes persist the literal CLI model ID.
 */
export class AiCustomModelModal {
  private readonly doc: Document
  private readonly labels: AiCustomModelModalLabels
  private overlay: HTMLElement | null = null
  private idInput: HTMLInputElement | null = null
  private nameInput: HTMLInputElement | null = null
  private descriptionInput: HTMLTextAreaElement | null = null
  private errorElement: HTMLElement | null = null
  private previewValue: HTMLElement | null = null

  constructor(private readonly options: AiCustomModelModalOptions) {
    this.doc = options.doc ?? document
    this.labels = { ...DEFAULT_LABELS, ...options.labels }
  }

  open(): void {
    if (this.overlay) return

    const editing = this.options.editModel !== undefined
    const sequence = modalSequence += 1
    const titleId = `ai-custom-model-modal-title-${sequence}`

    const overlay = this.doc.win.createDiv()
    overlay.className = 'ai-custom-model-modal'
    overlay.addEventListener('mousedown', this.handleBackdropMouseDown)

    const content = this.doc.win.createEl('section')
    content.className = 'ai-custom-model-modal__content'
    content.setAttribute('role', 'dialog')
    content.setAttribute('aria-modal', 'true')
    content.setAttribute('aria-labelledby', titleId)
    overlay.appendChild(content)

    const header = this.doc.win.createEl('header')
    header.className = 'ai-custom-model-modal__header'
    const titleWrap = this.doc.win.createDiv()
    titleWrap.className = 'ai-custom-model-modal__title-wrap'
    const titleIcon = this.doc.win.createSpan()
    titleIcon.className = 'ai-custom-model-modal__title-icon'
    setIcon(titleIcon, editing ? 'pencil' : 'plus')
    const title = this.doc.win.createEl('h2')
    title.id = titleId
    title.className = 'ai-custom-model-modal__title'
    title.textContent = editing ? this.labels.editTitle : this.labels.addTitle
    titleWrap.append(titleIcon, title)
    const closeButton = this.iconButton(
      'ai-custom-model-modal__close',
      this.labels.close,
      'x',
    )
    closeButton.addEventListener('click', () => this.close())
    header.append(titleWrap, closeButton)
    content.appendChild(header)

    const agent = this.doc.win.createDiv()
    agent.className = 'ai-custom-model-modal__agent'
    const agentIcon = this.doc.win.createSpan()
    agentIcon.className = 'ai-custom-model-modal__agent-icon'
    setIcon(agentIcon, 'bot')
    const agentText = this.doc.win.createSpan()
    agentText.textContent =
      this.options.host === 'claude'
        ? this.labels.claudeAgent
        : this.labels.codexAgent
    agent.append(agentIcon, agentText)
    content.appendChild(agent)

    const form = this.doc.win.createEl('form')
    form.className = 'ai-custom-model-modal__form'
    form.noValidate = true
    form.addEventListener('submit', this.handleSubmit)

    const idField = this.createFieldHeader(
      `${titleId}-model-id`,
      this.labels.modelId,
    )
    const idInput = this.doc.win.createEl('input')
    idInput.id = `${titleId}-model-id`
    idInput.type = 'text'
    idInput.className = 'ai-custom-model-modal__model-id'
    idInput.placeholder = this.labels.modelIdPlaceholder
    idInput.autocomplete = 'off'
    idInput.spellcheck = false
    idInput.value = this.options.editModel?.id ?? ''
    idInput.disabled = editing
    idInput.addEventListener('input', this.handleIdInput)
    const idHelp = this.doc.win.createDiv()
    idHelp.className = 'ai-custom-model-modal__help'
    idHelp.textContent = this.labels.modelIdHelp
    form.append(idField, idInput, idHelp)

    const nameField = this.createFieldHeader(
      `${titleId}-display-name`,
      this.labels.displayName,
    )
    const nameInput = this.doc.win.createEl('input')
    nameInput.id = `${titleId}-display-name`
    nameInput.type = 'text'
    nameInput.className = 'ai-custom-model-modal__display-name'
    nameInput.placeholder = this.labels.displayNamePlaceholder
    nameInput.autocomplete = 'off'
    nameInput.value = this.options.editModel?.label ?? ''
    nameInput.addEventListener('input', () => {
      nameInput.removeAttribute('aria-invalid')
      this.clearError()
    })
    form.append(nameField, nameInput)

    const descriptionField = this.createFieldHeader(
      `${titleId}-description`,
      this.labels.description,
    )
    const descriptionInput = this.doc.win.createEl('textarea')
    descriptionInput.id = `${titleId}-description`
    descriptionInput.className = 'ai-custom-model-modal__description'
    descriptionInput.placeholder = this.labels.descriptionPlaceholder
    descriptionInput.value = this.options.editModel?.description ?? ''
    descriptionInput.addEventListener('input', () => this.clearError())
    form.append(descriptionField, descriptionInput)

    const preview = this.doc.win.createDiv()
    preview.className = 'ai-custom-model-modal__preview-wrap'
    const previewLabel = this.doc.win.createSpan()
    previewLabel.className = 'ai-custom-model-modal__preview-label'
    previewLabel.textContent = this.labels.commandPreview
    const previewValue = this.doc.win.createEl('code')
    previewValue.className = 'ai-custom-model-modal__preview'
    preview.append(previewLabel, previewValue)
    form.appendChild(preview)

    const error = this.doc.win.createDiv()
    error.className = 'ai-custom-model-modal__error is-hidden'
    error.setAttribute('role', 'alert')
    error.setAttribute('aria-live', 'polite')
    form.appendChild(error)

    const actions = this.doc.win.createEl('footer')
    actions.className = 'ai-custom-model-modal__actions'
    const cancel = this.doc.win.createEl('button')
    cancel.type = 'button'
    cancel.className = 'ai-custom-model-modal__cancel'
    cancel.textContent = this.labels.cancel
    cancel.addEventListener('click', () => this.close())
    const submit = this.doc.win.createEl('button')
    submit.type = 'submit'
    submit.className = 'ai-custom-model-modal__submit mod-cta'
    submit.textContent = editing ? this.labels.save : this.labels.add
    actions.append(cancel, submit)
    form.appendChild(actions)
    content.appendChild(form)

    this.overlay = overlay
    this.idInput = idInput
    this.nameInput = nameInput
    this.descriptionInput = descriptionInput
    this.errorElement = error
    this.previewValue = previewValue
    this.updatePreview()
    this.doc.body.appendChild(overlay)
    this.doc.addEventListener('keydown', this.handleKeyDown)
    ;(editing ? nameInput : idInput).focus()
  }

  close(): void {
    if (!this.overlay) return
    this.doc.removeEventListener('keydown', this.handleKeyDown)
    this.overlay.removeEventListener('mousedown', this.handleBackdropMouseDown)
    this.overlay.remove()
    this.overlay = null
    this.idInput = null
    this.nameInput = null
    this.descriptionInput = null
    this.errorElement = null
    this.previewValue = null
    this.options.onClosed?.()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    this.close()
  }

  private readonly handleBackdropMouseDown = (event: MouseEvent): void => {
    if (event.target === this.overlay) this.close()
  }

  private readonly handleIdInput = (): void => {
    this.idInput?.removeAttribute('aria-invalid')
    this.clearError()
    this.updatePreview()
  }

  private readonly handleSubmit = (event: SubmitEvent): void => {
    event.preventDefault()
    const idInput = this.idInput
    const nameInput = this.nameInput
    const descriptionInput = this.descriptionInput
    if (!idInput || !nameInput || !descriptionInput) return

    this.clearError()
    idInput.removeAttribute('aria-invalid')
    nameInput.removeAttribute('aria-invalid')

    const id = idInput.value.trim()
    if (!this.options.editModel) {
      const idError = this.options.store.validateNewModelId(
        this.options.host,
        id,
      )
      if (idError) {
        idInput.setAttribute('aria-invalid', 'true')
        this.showError(idError)
        idInput.focus()
        return
      }
    }

    const label = nameInput.value.trim()
    if (label.length === 0) {
      nameInput.setAttribute('aria-invalid', 'true')
      this.showError('invalid-label')
      nameInput.focus()
      return
    }

    const description = descriptionInput.value.trim()
    const result = this.options.editModel
      ? this.options.store.update(this.options.host, this.options.editModel.id, {
          label,
          description,
        })
      : this.options.store.add(this.options.host, {
          id,
          label,
          ...(description ? { description } : {}),
        })

    if (!result.ok) {
      this.showError(result.error)
      return
    }

    this.close()
    this.options.onSaved?.(result.model)
  }

  private createFieldHeader(id: string, text: string): HTMLLabelElement {
    const label = this.doc.win.createEl('label')
    label.className = 'ai-custom-model-modal__label'
    label.htmlFor = id
    label.textContent = text
    return label
  }

  private iconButton(
    className: string,
    label: string,
    iconId: string,
  ): HTMLButtonElement {
    const button = this.doc.win.createEl('button')
    button.type = 'button'
    button.className = className
    button.setAttribute('aria-label', label)
    setIcon(button, iconId)
    return button
  }

  private updatePreview(): void {
    if (!this.previewValue) return
    const id = this.idInput?.value.trim() ?? ''
    this.previewValue.textContent = `--model=${id || '<model-id>'}`
  }

  private clearError(): void {
    if (!this.errorElement) return
    this.errorElement.textContent = ''
    this.errorElement.classList.add('is-hidden')
  }

  private showError(error: AiCustomModelMutationError): void {
    if (!this.errorElement) return
    const messages: Record<AiCustomModelMutationError, string> = {
      'invalid-id': this.labels.invalidId,
      'duplicate-id': this.labels.duplicateId,
      'invalid-label': this.labels.invalidLabel,
      'invalid-description': this.labels.invalidDescription,
      'not-found': this.labels.modelNotFound,
    }
    this.errorElement.textContent = messages[error]
    this.errorElement.classList.remove('is-hidden')
  }
}
