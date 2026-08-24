import { setIcon } from 'obsidian'
import { AI_MODEL_PRESETS } from '../config/AiTaskAdvancedOptions'
import type {
  AiCustomModel,
  AiCustomModelStore,
} from '../models/AiCustomModelStore'
import type { AiTaskHost } from '../types'
import {
  AiCustomModelModal,
  type AiCustomModelModalLabels,
} from './AiCustomModelModal'
import { positionScrollableDropdown } from './ScrollableDropdownPositioner'

export interface AiModelSelectLabels {
  openMenu: string
  defaultModel: string
  defaultDescription: string
  builtInModels: string
  customModels: string
  addCustomModel: string
  editCustomModel: string
  deleteCustomModel: string
}

export interface AiModelSelectValue {
  modelId: string | null
  isCustom: boolean
}

export interface AiModelSelectControllerOptions {
  doc?: Document
  host: AiTaskHost
  store: AiCustomModelStore
  modelId?: string | null
  isCustom?: boolean
  labels?: Partial<AiModelSelectLabels>
  customModelModalLabels?: Partial<AiCustomModelModalLabels>
  onChange?: (modelId: string | null, isCustom: boolean) => void
}

const DEFAULT_LABELS: AiModelSelectLabels = {
  openMenu: 'Choose AI model',
  defaultModel: 'Default model',
  defaultDescription: 'Use the model configured by the CLI',
  builtInModels: 'Available models',
  customModels: 'Custom models',
  addCustomModel: 'Add custom model',
  editCustomModel: 'Edit custom model',
  deleteCustomModel: 'Delete custom model',
}

let selectSequence = 0

/**
 * Host-aware model dropdown with a device-local custom-model catalog.
 *
 * Programmatic setters do not emit onChange. User selections, additions, and
 * deleting the currently selected custom model do emit `(modelId, isCustom)`.
 */
export class AiModelSelectController {
  private readonly doc: Document
  private readonly labels: AiModelSelectLabels
  private readonly root: HTMLElement
  private readonly menuId: string
  private host: AiTaskHost
  private selectedModelId: string | null = null
  private selectedIsCustom = false
  private trigger: HTMLButtonElement | null = null
  private menu: HTMLElement | null = null
  private activeModal: AiCustomModelModal | null = null
  private destroyed = false

  constructor(
    private readonly container: HTMLElement,
    private readonly options: AiModelSelectControllerOptions,
  ) {
    this.doc = options.doc ?? container.ownerDocument
    this.labels = { ...DEFAULT_LABELS, ...options.labels }
    this.host = options.host
    this.menuId = `ai-model-select-menu-${selectSequence += 1}`
    this.root = this.doc.win.createDiv()
    this.root.className = 'ai-model-select'
    this.container.appendChild(this.root)
    this.assignSelection(options.modelId ?? null, options.isCustom)
    this.doc.addEventListener('mousedown', this.handleDocumentMouseDown)
    this.doc.addEventListener('keydown', this.handleDocumentKeyDown)
    this.render()
  }

  getValue(): AiModelSelectValue {
    return {
      modelId: this.selectedModelId,
      isCustom: this.selectedIsCustom,
    }
  }

  setHost(host: AiTaskHost): void {
    if (this.destroyed || this.host === host) return
    this.closeOwnedModal()
    this.host = host
    this.selectedModelId = null
    this.selectedIsCustom = false
    this.render()
  }

  setValue(modelId: string | null, isCustom?: boolean): void {
    if (this.destroyed) return
    this.assignSelection(modelId, isCustom)
    this.render()
  }

  /** Re-read custom models after another picker changes the shared store. */
  refresh(): void {
    if (this.destroyed) return
    this.assignSelection(this.selectedModelId, this.selectedIsCustom)
    this.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.doc.removeEventListener('mousedown', this.handleDocumentMouseDown)
    this.doc.removeEventListener('keydown', this.handleDocumentKeyDown)
    this.closeOwnedModal()
    this.root.remove()
    this.trigger = null
    this.menu = null
  }

  private render(): void {
    this.root.replaceChildren()

    const trigger = this.doc.win.createEl('button')
    trigger.type = 'button'
    trigger.className = 'ai-model-select__trigger ai-task-model-select'
    trigger.setAttribute('aria-label', this.labels.openMenu)
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-controls', this.menuId)
    trigger.setAttribute('aria-expanded', 'false')
    const modelIcon = this.doc.win.createSpan()
    modelIcon.className = 'ai-model-select__trigger-icon'
    setIcon(modelIcon, 'cpu')
    const label = this.doc.win.createSpan()
    label.className = 'ai-model-select__trigger-label'
    label.textContent = this.getSelectedLabel()
    const chevron = this.doc.win.createSpan()
    chevron.className = 'ai-model-select__chevron'
    setIcon(chevron, 'chevron-down')
    trigger.append(modelIcon, label, chevron)
    trigger.addEventListener('click', () => this.toggleMenu())

    const menu = this.doc.win.createDiv()
    menu.id = this.menuId
    menu.className = 'ai-model-select__menu is-hidden'
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-hidden', 'true')

    const defaultRow = this.createOption({
      modelId: null,
      label: this.labels.defaultModel,
      description: this.labels.defaultDescription,
      isCustom: false,
    })
    menu.appendChild(defaultRow)

    menu.appendChild(this.createSectionHeading(this.labels.builtInModels))
    for (const model of AI_MODEL_PRESETS[this.host]) {
      menu.appendChild(
        this.createOption({
          modelId: model.id,
          label: model.label,
          isCustom: false,
        }),
      )
    }

    const customModels = this.options.store.getCustomModels(this.host)
    if (customModels.length > 0) {
      menu.appendChild(this.createSectionHeading(this.labels.customModels))
      for (const model of customModels) {
        menu.appendChild(this.createCustomRow(model))
      }
    }

    const add = this.doc.win.createEl('button')
    add.type = 'button'
    add.className = 'ai-model-select__add'
    const addIcon = this.doc.win.createSpan()
    addIcon.className = 'ai-model-select__add-icon'
    setIcon(addIcon, 'plus')
    const addLabel = this.doc.win.createSpan()
    addLabel.textContent = this.labels.addCustomModel
    add.append(addIcon, addLabel)
    add.addEventListener('click', () => this.openAddModal())
    menu.appendChild(add)

    this.root.append(trigger, menu)
    this.trigger = trigger
    this.menu = menu
  }

  private createSectionHeading(text: string): HTMLElement {
    const heading = this.doc.win.createDiv()
    heading.className = 'ai-model-select__section-heading'
    heading.textContent = text
    heading.setAttribute('role', 'presentation')
    return heading
  }

  private createOption(option: {
    modelId: string | null
    label: string
    description?: string
    isCustom: boolean
  }): HTMLButtonElement {
    const selected =
      this.selectedModelId === option.modelId &&
      this.selectedIsCustom === option.isCustom
    const button = this.doc.win.createEl('button')
    button.type = 'button'
    button.className = 'ai-model-select__option'
    button.classList.toggle('is-selected', selected)
    button.dataset.modelId = option.modelId ?? ''
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', selected ? 'true' : 'false')

    const marker = this.doc.win.createSpan()
    marker.className = 'ai-model-select__selection-marker'
    setIcon(marker, selected ? 'circle-check' : 'circle')
    const text = this.doc.win.createSpan()
    text.className = 'ai-model-select__option-text'
    const title = this.doc.win.createSpan()
    title.className = 'ai-model-select__option-title'
    title.textContent = option.label
    text.appendChild(title)
    if (option.description) {
      const description = this.doc.win.createSpan()
      description.className = 'ai-model-select__option-description'
      description.textContent = option.description
      text.appendChild(description)
    }
    button.append(marker, text)
    button.addEventListener('click', () => {
      this.selectFromUser(option.modelId, option.isCustom)
    })
    return button
  }

  private createCustomRow(model: AiCustomModel): HTMLElement {
    const row = this.doc.win.createDiv()
    row.className = 'ai-model-select__custom-row'
    row.dataset.modelId = model.id
    row.appendChild(
      this.createOption({
        modelId: model.id,
        label: model.label,
        description: model.description,
        isCustom: true,
      }),
    )

    const actions = this.doc.win.createDiv()
    actions.className = 'ai-model-select__custom-actions'
    const edit = this.iconButton(
      'ai-model-select__edit',
      `${this.labels.editCustomModel}: ${model.label}`,
      'pencil',
    )
    edit.addEventListener('click', () => this.openEditModal(model))
    const remove = this.iconButton(
      'ai-model-select__delete',
      `${this.labels.deleteCustomModel}: ${model.label}`,
      'trash-2',
    )
    remove.addEventListener('click', () => this.deleteCustomModel(model.id))
    actions.append(edit, remove)
    row.appendChild(actions)
    return row
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

  private toggleMenu(): void {
    if (this.menu?.classList.contains('is-hidden')) this.openMenu()
    else this.closeMenu(false)
  }

  private openMenu(): void {
    if (!this.menu || !this.trigger) return
    this.menu.classList.remove('is-hidden')
    this.menu.setAttribute('aria-hidden', 'false')
    this.trigger.setAttribute('aria-expanded', 'true')
    positionScrollableDropdown({
      anchor: this.trigger,
      menu: this.menu,
      boundary: this.root.closest<HTMLElement>('.task-modal-content'),
    })
  }

  private closeMenu(focusTrigger: boolean): void {
    if (!this.menu || !this.trigger) return
    this.menu.classList.add('is-hidden')
    this.menu.setAttribute('aria-hidden', 'true')
    this.trigger.setAttribute('aria-expanded', 'false')
    if (focusTrigger) this.trigger.focus()
  }

  private selectFromUser(modelId: string | null, isCustom: boolean): void {
    this.selectedModelId = modelId
    this.selectedIsCustom = modelId !== null && isCustom
    this.render()
    this.options.onChange?.(this.selectedModelId, this.selectedIsCustom)
  }

  private openAddModal(): void {
    this.closeMenu(false)
    this.closeOwnedModal()
    let modal: AiCustomModelModal
    modal = new AiCustomModelModal({
      doc: this.doc,
      host: this.host,
      store: this.options.store,
      labels: this.options.customModelModalLabels,
      onSaved: (model) => {
        if (this.destroyed) return
        this.selectedModelId = model.id
        this.selectedIsCustom = true
        this.render()
        this.options.onChange?.(model.id, true)
      },
      onClosed: () => {
        if (this.activeModal === modal) this.activeModal = null
      },
    })
    this.activeModal = modal
    modal.open()
  }

  private openEditModal(model: AiCustomModel): void {
    this.closeMenu(false)
    this.closeOwnedModal()
    let modal: AiCustomModelModal
    modal = new AiCustomModelModal({
      doc: this.doc,
      host: this.host,
      store: this.options.store,
      editModel: model,
      labels: this.options.customModelModalLabels,
      onSaved: () => {
        if (!this.destroyed) this.render()
      },
      onClosed: () => {
        if (this.activeModal === modal) this.activeModal = null
      },
    })
    this.activeModal = modal
    modal.open()
  }

  private deleteCustomModel(modelId: string): void {
    if (!this.options.store.remove(this.host, modelId)) return
    const deletedSelected =
      this.selectedIsCustom && this.selectedModelId === modelId
    if (deletedSelected) {
      this.selectedModelId = null
      this.selectedIsCustom = false
    }
    this.render()
    if (deletedSelected) this.options.onChange?.(null, false)
  }

  private getSelectedLabel(): string {
    if (this.selectedModelId === null) return this.labels.defaultModel
    if (this.selectedIsCustom) {
      return (
        this.options.store
          .getCustomModels(this.host)
          .find((model) => model.id === this.selectedModelId)?.label ??
        this.labels.defaultModel
      )
    }
    return (
      AI_MODEL_PRESETS[this.host].find(
        (model) => model.id === this.selectedModelId,
      )?.label ?? this.labels.defaultModel
    )
  }

  private assignSelection(
    modelId: string | null,
    isCustomHint?: boolean,
  ): void {
    const normalizedId = modelId?.trim() || null
    if (normalizedId === null) {
      this.selectedModelId = null
      this.selectedIsCustom = false
      return
    }

    const customExists = this.options.store
      .getCustomModels(this.host)
      .some((model) => model.id === normalizedId)
    const builtInExists = AI_MODEL_PRESETS[this.host].some(
      (model) => model.id === normalizedId,
    )
    if (customExists && isCustomHint !== false) {
      this.selectedModelId = normalizedId
      this.selectedIsCustom = true
      return
    }
    if (builtInExists) {
      this.selectedModelId = normalizedId
      this.selectedIsCustom = false
      return
    }
    if (customExists) {
      this.selectedModelId = normalizedId
      this.selectedIsCustom = true
      return
    }
    this.selectedModelId = null
    this.selectedIsCustom = false
  }

  private closeOwnedModal(): void {
    const modal = this.activeModal
    this.activeModal = null
    modal?.close()
  }

  private readonly handleDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target
    if (target && !this.root.contains(target as Node)) {
      this.closeMenu(false)
    }
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== 'Escape' ||
      this.menu?.classList.contains('is-hidden') !== false
    ) {
      return
    }
    event.preventDefault()
    this.closeMenu(true)
  }
}
