import { App, Notice } from 'obsidian'
import type { TaskInstance } from '../../../types'
import { Recipe, RecipeService } from '../services/RecipeService'
import { renderRecipeEmptyState } from '../ui/RecipeEmptyState'
import { attachCloseButtonIcon } from '../../../ui/components/iconUtils'
import { t } from '../../../i18n'
import { RecipeEditorForm, RecipeEditorValue } from '../ui/RecipeEditorForm'
import { showConfirmModal } from '../../../ui/modals/ConfirmModal'

let recipeSelectModalId = 0

export interface RecipeSelectModalOptions {
  service: RecipeService
  instance: TaskInstance
  onAssigned: () => Promise<void> | void
}

type Mode = 'select' | 'create'
export class RecipeSelectModal {
  private recipes: Recipe[] = []
  private mode: Mode = 'select'
  private createInitialTitle = ''
  private selectedRecipePath: string | null = null
  private listEl: HTMLElement | null = null
  private searchInput: HTMLInputElement | null = null
  private inlineEditor: RecipeEditorForm | null = null
  private createEditor: RecipeEditorForm | null = null
  private saveButton: HTMLButtonElement | null = null
  private suggestionsEl: HTMLElement | null = null
  private modalEl: HTMLDivElement | null = null
  private contentEl: HTMLDivElement | null = null
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null
  private escapeKeyDocument: Document | null = null
  private previouslyFocusedElement: HTMLElement | null = null
  private discardConfirmationPending = false
  private activeSuggestionIndex = -1
  private suggestionRecipes: Recipe[] = []
  private readonly dialogTitleId: string
  private readonly searchInputId: string
  private readonly suggestionsId: string

  constructor(private readonly app: App, private readonly options: RecipeSelectModalOptions) {
    recipeSelectModalId += 1
    this.dialogTitleId = `taskchute-recipe-select-title-${recipeSelectModalId}`
    this.searchInputId = `taskchute-recipe-select-search-${recipeSelectModalId}`
    this.suggestionsId = `taskchute-recipe-select-suggestions-${recipeSelectModalId}`
    this.createInitialTitle = this.getTaskTitle()
  }

  open(): void {
    const modalDocument = activeDocument
    this.previouslyFocusedElement = this.toFocusableElement(modalDocument.activeElement)
    this.modalEl = createDiv()
    this.modalEl.className = 'task-modal-overlay'
    this.contentEl = this.modalEl.createDiv( {
      cls: 'task-modal-content routine-edit-modal recipe-modal-content',
      attr: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': this.dialogTitleId,
        tabindex: '-1',
      },
    })
    this.modalEl.addEventListener('click', (event) => {
      if (event.target === this.modalEl) {
        void this.requestClose()
      }
    })
    modalDocument.body.appendChild(this.modalEl)
    this.escapeKeyHandler = (event: KeyboardEvent) => {
      if (this.discardConfirmationPending) return
      if (event.key === 'Tab') {
        this.trapFocus(event)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        void this.requestClose()
      }
    }
    this.escapeKeyDocument = modalDocument
    modalDocument.addEventListener('keydown', this.escapeKeyHandler)
    void this.loadRecipes()
  }

  close(): void {
    if (this.escapeKeyHandler) {
      const listenerDocument = this.escapeKeyDocument ?? activeDocument
      listenerDocument.removeEventListener('keydown', this.escapeKeyHandler)
      this.escapeKeyHandler = null
      this.escapeKeyDocument = null
    }
    this.modalEl?.remove()
    this.hideSuggestions()
    this.modalEl = null
    this.contentEl = null
    this.inlineEditor = null
    this.createEditor = null
    const focusTarget = this.previouslyFocusedElement
    this.previouslyFocusedElement = null
    if (focusTarget?.isConnected) {
      focusTarget.focus()
    }
  }

  private render(): void {
    if (!this.contentEl) return
    this.inlineEditor = null
    this.createEditor = null
    this.saveButton = null
    this.searchInput = null
    this.listEl = null
    this.hideSuggestions()
    this.contentEl.empty()
    if (this.mode === 'create') {
      this.renderCreate()
    } else {
      this.renderSelect()
    }
    const ownerWindow = this.contentEl.ownerDocument.defaultView ?? activeWindow
    ownerWindow.setTimeout(() => this.focusInitialElement(), 0)
  }

  private renderSelect(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.select.title', 'レシピを設定'), true)

    if (this.recipes.length > 0) {
      const titleGroup = this.contentEl.createDiv( { cls: 'form-group recipe-select-name-group' })
      titleGroup.createEl('label', {
        cls: 'form-label',
        text: t('recipes.select.nameLabel', 'レシピ名:'),
        attr: { for: this.searchInputId },
      })
      this.searchInput = this.contentEl.createEl('input', {
        cls: 'form-input recipe-search-input',
        attr: {
          type: 'search',
          id: this.searchInputId,
          role: 'combobox',
          autocomplete: 'off',
          'aria-autocomplete': 'list',
          'aria-expanded': 'false',
          'aria-controls': this.suggestionsId,
          placeholder: t('recipes.manager.searchPlaceholder', 'レシピを検索'),
        },
      })
      titleGroup.appendChild(this.searchInput)
      const selectedRecipe = this.recipes.find((recipe) => recipe.path === this.selectedRecipePath)
      if (selectedRecipe) {
        this.searchInput.value = selectedRecipe.title
      }
      this.searchInput.addEventListener('input', () => {
        this.selectedRecipePath = null
        this.activeSuggestionIndex = -1
        this.updateSaveButton()
        this.updateInlineEditorState()
        this.renderSuggestions()
      })
      this.searchInput.addEventListener('keydown', (event) => this.handleSearchKeydown(event))
      this.renderInlineCreateFields()
      const createButton = this.contentEl.createEl('button', {
        cls: 'form-button cancel recipe-select-create-new-button',
        text: t('recipes.select.createNew', '新しいレシピを作る'),
        attr: { type: 'button' },
      })
      createButton.addEventListener('click', () => this.enterCreateMode())
    } else {
      this.searchInput = null
      this.inlineEditor = null
    }
    this.listEl = this.contentEl.createDiv( { cls: 'recipe-select-list recipe-select-list--empty' })
    if (this.recipes.length > 0) {
      this.renderSelectFooter()
    } else {
      renderRecipeEmptyState(this.listEl, {
        onCreate: () => {
          this.enterCreateMode()
        },
      })
    }
  }

  private renderInlineCreateFields(): void {
    if (!this.contentEl) return
    const editorContainer = this.contentEl.createDiv({ cls: 'recipe-select-create-fields' })
    this.inlineEditor = new RecipeEditorForm(editorContainer, {}, {
      showTitle: false,
      onChange: () => this.updateSaveButton(),
    })
    this.updateInlineEditorState()
  }

  private renderSuggestions(): void {
    this.hideSuggestions()
    if (!this.searchInput) return
    const query = this.searchInput?.value.trim().toLowerCase() ?? ''
    const recipes = this.recipes.filter((recipe) => {
      if (!query) return false
      return recipe.title.toLowerCase().includes(query) || recipe.path.toLowerCase().includes(query)
    })
    this.suggestionRecipes = recipes.slice(0, 15)
    if (this.suggestionRecipes.length === 0) return

    const suggestions = createDiv()
    suggestions.className = 'taskchute-autocomplete-suggestions recipe-autocomplete-suggestions'
    suggestions.id = this.suggestionsId
    suggestions.setAttribute('role', 'listbox')
    this.suggestionRecipes.forEach((recipe, index) => {
      const item = createDiv()
      item.className = 'suggestion-item'
      item.id = `${this.suggestionsId}-option-${index}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(index === this.activeSuggestionIndex))
      const title = createDiv()
      title.className = 'suggestion-title'
      const label = createSpan()
      label.textContent = recipe.title
      title.appendChild(label)
      item.appendChild(title)
      item.addEventListener('mousedown', (event) => event.preventDefault())
      item.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.selectExistingRecipe(recipe)
      })
      suggestions.appendChild(item)
    })
    const rect = this.searchInput.getBoundingClientRect()
    suggestions.style.top = `${rect.bottom + 2}px`
    suggestions.style.left = `${rect.left}px`
    suggestions.style.width = `${rect.width}px`
    activeDocument.body.appendChild(suggestions)
    this.suggestionsEl = suggestions
    this.searchInput.setAttribute('aria-expanded', 'true')
    this.updateActiveSuggestion()
  }

  private renderCreate(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.manager.createTitle', 'レシピ新規作成'), true)

    const form = this.contentEl.createEl('form', { cls: 'task-form recipe-edit-form' })
    this.createEditor = new RecipeEditorForm(form, { title: this.createInitialTitle })

    const buttonGroup = form.createDiv( { cls: 'form-button-group' })
    const cancelButton = buttonGroup.createEl('button', {
      cls: 'form-button cancel',
      text: t('common.cancel', 'キャンセル'),
      attr: { type: 'button' },
    })
    const saveButton = buttonGroup.createEl('button', {
      cls: 'form-button create',
      text: t('recipes.manager.saveButton', '保存'),
      attr: { type: 'submit' },
    })
    cancelButton.addEventListener('click', () => {
      void this.requestLeaveCreate()
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!this.createEditor?.validate()) return
      saveButton.disabled = true
      void this.createAndAssign(this.createEditor.getValue())
        .finally(() => {
          saveButton.disabled = false
        })
    })
  }

  private renderSelectFooter(): void {
    if (!this.contentEl) return
    const buttonGroup = this.contentEl.createDiv( { cls: 'form-button-group recipe-select-footer' })
    const cancelButton = buttonGroup.createEl('button', {
      cls: 'form-button cancel',
      text: t('common.cancel', 'キャンセル'),
      attr: { type: 'button' },
    })
    if (this.options.instance.task.recipePath) {
      const clearButton = buttonGroup.createEl('button', {
        cls: 'form-button cancel recipe-select-clear-button',
        text: t('recipes.select.clear', 'レシピを解除'),
        attr: { type: 'button' },
      })
      clearButton.addEventListener('click', () => {
        clearButton.disabled = true
        void this.unassign().finally(() => {
          clearButton.disabled = false
        })
      })
    }
    this.saveButton = buttonGroup.createEl('button', {
      cls: 'form-button create recipe-select-save-button',
      text: t('recipes.manager.saveButton', '保存'),
      attr: { type: 'button' },
    })
    cancelButton.addEventListener('click', () => void this.requestClose())
    this.saveButton.addEventListener('click', () => {
      const recipe = this.resolveRecipeForSave()
      const title = this.searchInput?.value.trim() ?? ''
      if (!recipe && !title) return
      if (!recipe) {
        if (!this.inlineEditor?.validate(title)) return
        this.hideSuggestions()
        this.saveButton!.disabled = true
        void this.createAndAssign(this.inlineEditor.getValue(title)).finally(() => {
          if (this.saveButton) {
            this.saveButton.disabled = false
          }
        })
        return
      }
      this.saveButton!.disabled = true
      void this.assign(recipe).finally(() => {
        if (this.saveButton) {
          this.saveButton.disabled = false
        }
      })
    })
    this.updateSaveButton()
  }

  private updateSaveButton(): void {
    if (!this.saveButton) return
    const title = this.searchInput?.value.trim() ?? ''
    const recipe = this.resolveRecipeForSave()
    const value = this.inlineEditor?.getValue(title)
    const hasContent = Boolean(
      value?.goal
      || value?.steps.length
      || value?.qualityChecks.length
      || value?.constraints.length,
    )
    this.saveButton.disabled = recipe ? false : title.length === 0 || !hasContent
  }

  private selectExistingRecipe(recipe: Recipe): void {
    this.selectedRecipePath = recipe.path
    if (this.searchInput) {
      this.searchInput.value = recipe.title
    }
    this.hideSuggestions()
    this.updateInlineEditorState()
    this.updateSaveButton()
  }

  private updateInlineEditorState(): void {
    const group = this.contentEl?.querySelector<HTMLElement>('.recipe-select-create-fields')
    if (!group) return
    const recipe = this.resolveRecipeForSave()
    group.style.display = recipe ? 'none' : ''
  }

  private hideSuggestions(): void {
    this.suggestionsEl?.remove()
    this.suggestionsEl = null
    this.suggestionRecipes = []
    this.activeSuggestionIndex = -1
    this.searchInput?.setAttribute('aria-expanded', 'false')
    this.searchInput?.removeAttribute('aria-activedescendant')
  }

  private resolveRecipeForSave(): Recipe | undefined {
    const selected = this.recipes.find((item) => item.path === this.selectedRecipePath)
    if (selected) return selected
    const title = this.searchInput?.value.trim().toLowerCase()
    if (!title) return undefined
    return this.recipes.find((recipe) => recipe.title.trim().toLowerCase() === title)
  }

  private renderHeader(title: string, showClose: boolean): void {
    const header = this.contentEl?.createDiv( { cls: 'modal-header recipe-modal-header' })
    if (!header) return
    header.createEl('h3', { text: title, attr: { id: this.dialogTitleId } })
    if (!showClose) return
    const closeButton = header.createEl('button', {
      cls: 'modal-close-button',
      attr: {
        type: 'button',
        title: t('common.close', '閉じる'),
        'aria-label': t('common.close', '閉じる'),
      },
    })
    attachCloseButtonIcon(closeButton)
    closeButton.addEventListener('click', () => void this.requestClose())
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.suggestionsEl) {
      event.preventDefault()
      event.stopPropagation()
      this.hideSuggestions()
      return
    }
    if (event.key === 'Enter' && this.activeSuggestionIndex >= 0) {
      const recipe = this.suggestionRecipes[this.activeSuggestionIndex]
      if (!recipe) return
      event.preventDefault()
      this.selectExistingRecipe(recipe)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!this.suggestionsEl) {
      this.renderSuggestions()
    }
    if (this.suggestionRecipes.length === 0) return
    if (event.key === 'ArrowDown') {
      this.activeSuggestionIndex = this.activeSuggestionIndex < this.suggestionRecipes.length - 1
        ? this.activeSuggestionIndex + 1
        : 0
    } else {
      this.activeSuggestionIndex = this.activeSuggestionIndex > 0
        ? this.activeSuggestionIndex - 1
        : this.suggestionRecipes.length - 1
    }
    this.updateActiveSuggestion()
  }

  private updateActiveSuggestion(): void {
    const options = Array.from(this.suggestionsEl?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    options.forEach((option, index) => {
      const isActive = index === this.activeSuggestionIndex
      option.classList.toggle('is-selected', isActive)
      option.setAttribute('aria-selected', String(isActive))
    })
    const activeOption = options[this.activeSuggestionIndex]
    if (activeOption) {
      this.searchInput?.setAttribute('aria-activedescendant', activeOption.id)
      activeOption.scrollIntoView?.({ block: 'nearest' })
    } else {
      this.searchInput?.removeAttribute('aria-activedescendant')
    }
  }

  private enterCreateMode(): void {
    this.createInitialTitle = this.getTaskTitle()
    this.mode = 'create'
    this.render()
  }

  private async requestLeaveCreate(): Promise<void> {
    if (this.createEditor?.isDirty()) {
      const confirmed = await this.confirmDiscardChanges()
      if (!confirmed) return
    }
    if (this.recipes.length > 0) {
      this.mode = 'select'
      this.render()
      return
    }
    this.close()
  }

  private async requestClose(): Promise<void> {
    if (!this.hasUnsavedChanges()) {
      this.close()
      return
    }
    const confirmed = await this.confirmDiscardChanges()
    if (confirmed) this.close()
  }

  private hasUnsavedChanges(): boolean {
    if (this.mode === 'create') {
      return this.createEditor?.isDirty() ?? false
    }
    if (this.resolveRecipeForSave()) return false
    return this.inlineEditor?.isDirty(this.searchInput?.value ?? '') ?? false
  }

  private async confirmDiscardChanges(): Promise<boolean> {
    if (this.discardConfirmationPending) return false
    this.discardConfirmationPending = true
    try {
      return await showConfirmModal(this.app, {
        title: t('recipes.manager.discardTitle', '未保存の変更'),
        message: t('recipes.manager.discardMessage', '未保存の変更を破棄しますか？'),
        confirmText: t('recipes.manager.discardButton', '破棄'),
        cancelText: t('common.cancel', 'キャンセル'),
        destructive: true,
      })
    } finally {
      this.discardConfirmationPending = false
    }
  }

  private trapFocus(event: KeyboardEvent): void {
    if (!this.contentEl) return
    const focusable = this.getFocusableElements()
    if (focusable.length === 0) {
      event.preventDefault()
      this.contentEl.focus()
      return
    }
    const active = this.contentEl.ownerDocument.activeElement
    const currentIndex = focusable.indexOf(active as HTMLElement)
    const atBoundary = currentIndex < 0
      || (event.shiftKey && currentIndex === 0)
      || (!event.shiftKey && currentIndex === focusable.length - 1)
    if (!atBoundary) return
    event.preventDefault()
    const next = event.shiftKey ? focusable[focusable.length - 1] : focusable[0]
    next?.focus()
  }

  private getFocusableElements(): HTMLElement[] {
    if (!this.contentEl) return []
    return Array.from(this.contentEl.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
  }

  private focusInitialElement(): void {
    if (!this.contentEl?.isConnected) return
    if (this.mode === 'create' && this.createEditor) {
      this.createEditor.focus()
      return
    }
    const preferred = this.contentEl.querySelector<HTMLElement>('.recipe-search-input')
    ;(preferred ?? this.getFocusableElements()[0])?.focus()
  }

  private getTaskTitle(): string {
    return this.options.instance.task.displayTitle ?? this.options.instance.task.name ?? ''
  }

  private toFocusableElement(element: Element | null): HTMLElement | null {
    return element && typeof (element as HTMLElement).focus === 'function'
      ? element as HTMLElement
      : null
  }

  private async loadRecipes(): Promise<void> {
    try {
      this.recipes = await this.options.service.loadRecipes()
      const assignedPath = this.options.instance.task.recipePath
      this.selectedRecipePath = assignedPath && this.recipes.some((recipe) => recipe.path === assignedPath)
        ? assignedPath
        : null
      this.render()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to load recipes', error)
      new Notice(t('recipes.select.notices.loadFailed', 'レシピ一覧の読み込みに失敗しました'))
      this.close()
    }
  }

  private async assign(recipe: Recipe): Promise<boolean> {
    try {
      await this.options.service.assignRecipeToTask(this.options.instance.task.path, recipe.path)
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to assign recipe', error)
      new Notice(t('recipes.select.notices.assignFailed', 'レシピの設定に失敗しました'))
      return false
    }

    this.close()
    try {
      await this.options.onAssigned()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to refresh after assigning recipe', error)
    }
    return true
  }

  private async unassign(): Promise<void> {
    try {
      await this.options.service.unassignRecipeFromTask(this.options.instance.task.path)
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to unassign recipe', error)
      new Notice(t('recipes.select.notices.unassignFailed', 'レシピの解除に失敗しました'))
      return
    }

    this.close()
    try {
      await this.options.onAssigned()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to refresh after unassigning recipe', error)
    }
  }

  private async createAndAssign(value: RecipeEditorValue): Promise<void> {
    try {
      const recipe = await this.options.service.saveRecipe(value)
      const assigned = await this.assign(recipe)
      if (assigned) return
      if (!this.recipes.some((item) => item.path === recipe.path)) {
        this.recipes.push(recipe)
      }
      this.selectedRecipePath = recipe.path
      this.mode = 'select'
      this.render()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to create recipe', error)
      new Notice(error instanceof Error ? error.message : t('recipes.select.notices.createFailed', 'レシピの作成に失敗しました'))
    }
  }
}
