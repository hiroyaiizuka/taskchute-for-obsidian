import { setIcon } from 'obsidian'
import type { ElectronDirectoryPicker } from '../services/ElectronDirectoryPicker'
import {
  normalizeDirectoryPath,
  normalizeDirectoryPathForComparison,
  type WorkingDirectoryHistory,
} from '../services/WorkingDirectoryHistory'
import { positionScrollableDropdown } from './ScrollableDropdownPositioner'

export interface WorkingDirectorySelectLabels {
  browse: string
  defaultBadge: string
  recentHeader: string
  resetDefault: string
  placeholder: string
}

const DEFAULT_LABELS: WorkingDirectorySelectLabels = {
  browse: 'Choose folder',
  defaultBadge: 'Default',
  recentHeader: 'Recently used directories',
  resetDefault: 'Reset to default',
  placeholder: '/path/to/workspace',
}

export interface WorkingDirectorySelectControllerOptions {
  /** Omit to initialize the editable field from the default directory. */
  value?: string
  defaultDirectory?: string
  /** Working directories discovered from existing AI task notes. */
  candidateDirectories?: readonly string[]
  history: WorkingDirectoryHistory
  picker: Pick<ElectronDirectoryPicker, 'selectDirectory'>
  labels?: Partial<WorkingDirectorySelectLabels>
  onChange?: (value: string) => void
}

interface DirectoryDisplayParts {
  folder: string
  parent: string
}

interface OptionRow {
  path: string
  element: HTMLButtonElement
}

function isDirectoryRoot(path: string): boolean {
  return (
    path === '/' ||
    /^[a-z]:\/$/i.test(path) ||
    /^\/\/[^/]+\/[^/]+$/i.test(path)
  )
}

function getDirectoryDisplayParts(path: string): DirectoryDisplayParts {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized || isDirectoryRoot(normalized)) {
    return { folder: normalized, parent: '' }
  }
  const separator = normalized.lastIndexOf('/')
  if (separator < 0) return { folder: normalized, parent: '' }
  return {
    folder: normalized.slice(separator + 1),
    parent: separator === 0 ? '/' : normalized.slice(0, separator),
  }
}

/**
 * Imperative counterpart of the reference WorkingDirectorySelect React
 * component. The controller owns only the DOM it appends to `container` and
 * exposes a small value/history lifecycle for TaskCreationController.
 */
export class WorkingDirectorySelectController {
  private readonly root: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly inputWrapper: HTMLDivElement
  private readonly menu: HTMLDivElement
  private readonly toggleButton: HTMLButtonElement | null
  private readonly resetButton: HTMLButtonElement | null
  private readonly defaultDirectory: string
  private readonly labels: WorkingDirectorySelectLabels
  private readonly optionRows: OptionRow[] = []
  private isOpen = false
  private destroyed = false
  private browseGeneration = 0

  private readonly handleDocumentMouseDown = (event: MouseEvent): void => {
    if (!this.isOpen || this.destroyed) return
    // Avoid a global `instanceof Node`: Obsidian pop-out windows have their
    // own DOM realm, so an owner-document node is not an instance of the main
    // window's Node constructor.
    if (event.target && this.root.contains(event.target as Node)) return
    this.closeMenu()
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpen || this.destroyed || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.closeMenu()
    this.toggleButton?.focus()
  }

  constructor(
    container: HTMLElement,
    private readonly options: WorkingDirectorySelectControllerOptions,
  ) {
    const doc = container.ownerDocument
    this.labels = { ...DEFAULT_LABELS, ...options.labels }
    const choices = options.history.getChoices(
      options.candidateDirectories ?? [],
      options.defaultDirectory ?? '',
    )
    this.defaultDirectory = choices.defaultDirectory

    this.root = doc.createElement('div')
    this.root.className = 'ai-working-directory-select'
    container.appendChild(this.root)

    const inputRow = doc.createElement('div')
    inputRow.className = 'ai-working-directory-select__input-row'
    this.root.appendChild(inputRow)

    this.inputWrapper = doc.createElement('div')
    this.inputWrapper.className = 'ai-working-directory-select__input-wrapper'
    inputRow.appendChild(this.inputWrapper)

    this.input = doc.createElement('input')
    this.input.type = 'text'
    this.input.className =
      'form-input ai-working-directory-select__input ai-task-cwd-input'
    this.input.value = options.value ?? this.defaultDirectory
    this.input.placeholder = this.defaultDirectory || this.labels.placeholder
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.inputWrapper.appendChild(this.input)

    if (choices.recentDirectories.length > 0) {
      this.toggleButton = doc.createElement('button')
      this.toggleButton.type = 'button'
      this.toggleButton.className = 'ai-working-directory-select__toggle'
      this.toggleButton.setAttribute('aria-label', this.labels.recentHeader)
      this.toggleButton.setAttribute('aria-expanded', 'false')
      setIcon(this.toggleButton, 'chevron-down')
      this.inputWrapper.appendChild(this.toggleButton)
      this.toggleButton.addEventListener('click', () => this.toggleMenu())
    } else {
      this.toggleButton = null
    }

    const browseButton = doc.createElement('button')
    browseButton.type = 'button'
    browseButton.className = 'ai-working-directory-select__browse'
    browseButton.setAttribute('aria-label', this.labels.browse)
    browseButton.title = this.labels.browse
    setIcon(browseButton, 'folder')
    inputRow.appendChild(browseButton)
    browseButton.addEventListener('click', () => {
      void this.browse()
    })

    this.menu = doc.createElement('div')
    this.menu.className = 'ai-working-directory-select__menu is-hidden'
    this.menu.setAttribute('role', 'listbox')
    this.inputWrapper.appendChild(this.menu)

    if (this.defaultDirectory) {
      this.renderDefaultOption(doc)
    }
    if (choices.recentDirectories.length > 0) {
      this.renderRecentOptions(doc, choices.recentDirectories)
    }

    if (this.defaultDirectory) {
      this.resetButton = doc.createElement('button')
      this.resetButton.type = 'button'
      this.resetButton.className = 'ai-working-directory-select__reset'
      this.resetButton.textContent = this.labels.resetDefault
      this.root.appendChild(this.resetButton)
      this.resetButton.addEventListener('click', () => {
        this.applyValue(this.defaultDirectory, true)
        this.closeMenu()
      })
    } else {
      this.resetButton = null
    }

    this.input.addEventListener('input', () => {
      this.syncSelectionState()
      this.options.onChange?.(this.input.value)
    })
    this.syncSelectionState()

    doc.addEventListener('mousedown', this.handleDocumentMouseDown, true)
    doc.addEventListener('keydown', this.handleDocumentKeyDown, true)
  }

  getValue(): string {
    return this.input.value
  }

  /** Persist the current custom value after the owning task save succeeds. */
  commitHistory(): string[] {
    if (this.destroyed) return this.options.history.getStoredDirectories()
    return this.options.history.add(this.input.value, this.defaultDirectory)
  }

  /** Open the native picker; public for integration tests and host commands. */
  async browse(): Promise<void> {
    if (this.destroyed) return
    this.browseGeneration += 1
    const generation = this.browseGeneration
    const current = this.input.value.trim()
    const selected = await this.options.picker.selectDirectory(
      current || this.defaultDirectory || undefined,
    )
    if (this.destroyed || generation !== this.browseGeneration || !selected) {
      return
    }
    this.applyValue(selected, true)
    this.closeMenu()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.browseGeneration += 1
    const doc = this.root.ownerDocument
    doc.removeEventListener('mousedown', this.handleDocumentMouseDown, true)
    doc.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    this.root.remove()
  }

  private renderDefaultOption(doc: Document): void {
    const parts = getDirectoryDisplayParts(this.defaultDirectory)
    const row = this.createOptionRow(
      doc,
      this.defaultDirectory,
      'ai-working-directory-select__option--default',
    )
    const icon = doc.createElement('span')
    icon.className = 'ai-working-directory-select__option-icon'
    setIcon(icon, 'home')
    row.appendChild(icon)

    const content = doc.createElement('span')
    content.className = 'ai-working-directory-select__option-content'
    this.appendOptionText(doc, content, parts.folder, this.defaultDirectory)
    row.appendChild(content)

    const badge = doc.createElement('span')
    badge.className = 'ai-working-directory-select__default-badge'
    badge.textContent = this.labels.defaultBadge
    row.appendChild(badge)
  }

  private renderRecentOptions(doc: Document, directories: readonly string[]): void {
    const separator = doc.createElement('div')
    separator.className = 'ai-working-directory-select__separator'
    this.menu.appendChild(separator)

    const heading = doc.createElement('div')
    heading.className = 'ai-working-directory-select__recent-header'
    const clock = doc.createElement('span')
    clock.className = 'ai-working-directory-select__recent-icon'
    setIcon(clock, 'clock')
    heading.appendChild(clock)
    const headingText = doc.createElement('span')
    headingText.textContent = this.labels.recentHeader
    heading.appendChild(headingText)
    this.menu.appendChild(heading)

    for (const directory of directories) {
      const parts = getDirectoryDisplayParts(directory)
      const row = this.createOptionRow(doc, directory)
      const icon = doc.createElement('span')
      icon.className = 'ai-working-directory-select__option-icon'
      setIcon(icon, 'folder')
      row.appendChild(icon)
      const content = doc.createElement('span')
      content.className = 'ai-working-directory-select__option-content'
      this.appendOptionText(doc, content, parts.folder, parts.parent)
      row.appendChild(content)
    }
  }

  private createOptionRow(
    doc: Document,
    path: string,
    extraClass = '',
  ): HTMLButtonElement {
    const row = doc.createElement('button')
    row.type = 'button'
    row.className = `ai-working-directory-select__option ${extraClass}`.trim()
    row.dataset.path = path
    row.title = path
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', 'false')
    row.addEventListener('click', () => {
      this.applyValue(path, true)
      this.closeMenu()
    })
    this.menu.appendChild(row)
    this.optionRows.push({ path, element: row })
    return row
  }

  private appendOptionText(
    doc: Document,
    content: HTMLElement,
    folder: string,
    parent: string,
  ): void {
    const title = doc.createElement('span')
    title.className = 'ai-working-directory-select__option-title'
    title.textContent = folder
    content.appendChild(title)
    const parentText = doc.createElement('span')
    parentText.className = 'ai-working-directory-select__option-parent'
    parentText.textContent = parent
    content.appendChild(parentText)
  }

  private applyValue(value: string, notify: boolean): void {
    if (this.destroyed) return
    this.input.value = value
    this.syncSelectionState()
    if (notify) this.options.onChange?.(value)
  }

  private syncSelectionState(): void {
    const currentKey = normalizeDirectoryPathForComparison(this.input.value)
    for (const option of this.optionRows) {
      const selected =
        currentKey.length > 0 &&
        normalizeDirectoryPathForComparison(option.path) === currentKey
      option.element.classList.toggle('is-selected', selected)
      option.element.setAttribute('aria-selected', selected ? 'true' : 'false')
    }

    if (this.resetButton) {
      const defaultKey = normalizeDirectoryPathForComparison(this.defaultDirectory)
      this.resetButton.classList.toggle(
        'is-hidden',
        currentKey.length > 0 && currentKey === defaultKey,
      )
    }
  }

  private toggleMenu(): void {
    if (this.destroyed || !this.toggleButton) return
    this.setMenuOpen(!this.isOpen)
  }

  private closeMenu(): void {
    this.setMenuOpen(false)
  }

  private setMenuOpen(open: boolean): void {
    if (this.destroyed) return
    this.isOpen = open
    this.menu.classList.toggle('is-hidden', !open)
    this.toggleButton?.classList.toggle('is-open', open)
    this.toggleButton?.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) {
      positionScrollableDropdown({
        anchor: this.inputWrapper,
        menu: this.menu,
        boundary: this.root.closest<HTMLElement>('.task-modal-content'),
      })
    }
  }
}
