import { App, Modal, Notice } from 'obsidian'
import type { TaskInstance } from '../../../types'
import { Recipe, RecipeService } from '../services/RecipeService'
import { renderRecipeEmptyState } from '../ui/RecipeEmptyState'
import { t } from '../../../i18n'
import { RecipeEditorForm, RecipeEditorValue } from '../ui/RecipeEditorForm'
import { showConfirmModal } from '../../../ui/modals/ConfirmModal'
import { createModalFooter } from '../../../ui/components/modalFooter'

let recipeSelectModalId = 0

export interface RecipeSelectModalOptions {
  service: RecipeService
  instance: TaskInstance
  onAssigned: () => Promise<void> | void
}

type Mode = 'select' | 'create'
export class RecipeSelectModal extends Modal {
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
  private activeSuggestionIndex = -1
  /** Set once the discard prompt has been answered, so `close()` lets go. */
  private closeConfirmed = false
  private suggestionRecipes: Recipe[] = []
  private readonly dialogTitleId: string
  private readonly searchInputId: string
  private readonly suggestionsId: string

  constructor(app: App, private readonly options: RecipeSelectModalOptions) {
    super(app)
    recipeSelectModalId += 1
    this.dialogTitleId = `taskchute-recipe-select-title-${recipeSelectModalId}`
    this.searchInputId = `taskchute-recipe-select-search-${recipeSelectModalId}`
    this.suggestionsId = `taskchute-recipe-select-suggestions-${recipeSelectModalId}`
    this.createInitialTitle = this.getTaskTitle()
  }

  onOpen(): void {
    this.modalEl.addClass('taskchute-modal', 'taskchute-modal--no-close', 'recipe-modal-content')
    // Obsidian does not mark the frame up as a dialog, so keep the roles the
    // hand-rolled overlay used to carry.
    this.modalEl.setAttribute('role', 'dialog')
    this.modalEl.setAttribute('aria-modal', 'true')
    this.modalEl.setAttribute('aria-labelledby', this.dialogTitleId)
    void this.loadRecipes()
  }

  /**
   * Escape, the close glyph and a backdrop click all route through `close()`,
   * so the unsaved-changes prompt has to live here rather than in a hand-rolled
   * key handler.
   */
  close(): void {
    if (this.closeConfirmed || !this.hasUnsavedChanges()) {
      super.close()
      return
    }
    void this.confirmDiscardChanges().then((confirmed) => {
      if (!confirmed) return
      this.closeConfirmed = true
      super.close()
    })
  }

  /** Close without re-asking: the caller has already settled the edit. */
  private forceClose(): void {
    this.closeConfirmed = true
    this.close()
  }

  onClose(): void {
    this.hideSuggestions()
    this.inlineEditor?.destroy()
    this.createEditor?.destroy()
    this.inlineEditor = null
    this.createEditor = null
    this.contentEl.empty()
  }

  private render(): void {
    // Re-rendering discards the forms, so a reorder still in flight has to go
    // with them -- its ghost is on `body` and would otherwise be orphaned.
    this.inlineEditor?.destroy()
    this.createEditor?.destroy()
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
    this.renderHeader(t('recipes.select.title', 'Set recipe'))

    if (this.recipes.length > 0) {
      const titleGroup = this.contentEl.createDiv( { cls: 'form-group recipe-select-name-group' })
      titleGroup.createEl('label', {
        cls: 'form-label',
        text: t('recipes.select.nameLabel', 'Recipe name:'),
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
          placeholder: t('recipes.manager.searchPlaceholder', 'Search recipes'),
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
        text: t('recipes.select.createNew', 'Create a new recipe'),
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
    this.renderHeader(t('recipes.manager.createTitle', 'Create recipe'))

    const form = this.contentEl.createEl('form', { cls: 'task-form recipe-edit-form' })
    this.createEditor = new RecipeEditorForm(form, { title: this.createInitialTitle })

    let saveButton: HTMLButtonElement | undefined
    createModalFooter(form, [
      {
        text: t('common.cancel', 'Cancel'),
        role: 'cancel',
        onClick: () => {
          void this.requestLeaveCreate()
        },
      },
      {
        text: t('recipes.manager.saveButton', 'Save'),
        role: 'primary',
        type: 'submit',
        ref: (button) => {
          saveButton = button
        },
      },
    ])

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!this.createEditor?.validate() || !saveButton) return
      const button = saveButton
      button.disabled = true
      void this.createAndAssign(this.createEditor.getValue())
        .finally(() => {
          button.disabled = false
        })
    })
  }

  private renderSelectFooter(): void {
    if (!this.contentEl) return
    // Clearing the assignment is an aside to picking one, so it takes the
    // row's secondary slot rather than a third seat beside cancel and save.
    let clearButton: HTMLButtonElement | undefined
    createModalFooter(this.contentEl, [
      ...(this.options.instance.task.recipePath
        ? [
            {
              text: t('recipes.select.clear', 'Remove recipe'),
              role: 'secondary' as const,
              cls: 'recipe-select-clear-button',
              ref: (button: HTMLButtonElement) => {
                clearButton = button
              },
              onClick: () => {
                if (!clearButton) return
                clearButton.disabled = true
                void this.unassign().finally(() => {
                  if (clearButton) clearButton.disabled = false
                })
              },
            },
          ]
        : []),
      { text: t('common.cancel', 'Cancel'), role: 'cancel', onClick: () => this.close() },
      {
        text: t('recipes.manager.saveButton', 'Save'),
        role: 'primary',
        cls: 'recipe-select-save-button',
        ref: (button) => {
          this.saveButton = button
        },
        onClick: () => {
          const recipe = this.resolveRecipeForSave()
          const title = this.searchInput?.value.trim() ?? ''
          if (!recipe && !title) return
          const setBusy = (busy: boolean): void => {
            if (this.saveButton) this.saveButton.disabled = busy
          }
          if (!recipe) {
            if (!this.inlineEditor?.validate(title)) return
            this.hideSuggestions()
            setBusy(true)
            void this.createAndAssign(this.inlineEditor.getValue(title)).finally(() => {
              setBusy(false)
            })
            return
          }
          setBusy(true)
          void this.assign(recipe).finally(() => {
            setBusy(false)
          })
        },
      },
    ])
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

  private renderHeader(title: string): void {
    this.setTitle(title)
    this.titleEl.id = this.dialogTitleId
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
    this.forceClose()
  }

  private hasUnsavedChanges(): boolean {
    if (this.mode === 'create') {
      return this.createEditor?.isDirty() ?? false
    }
    if (this.resolveRecipeForSave()) return false
    return this.inlineEditor?.isDirty(this.searchInput?.value ?? '') ?? false
  }

  private confirmDiscardChanges(): Promise<boolean> {
    return showConfirmModal(this.app, {
      title: t('recipes.manager.discardTitle', 'Unsaved changes'),
      message: t('recipes.manager.discardMessage', 'Discard your unsaved changes?'),
      confirmText: t('recipes.manager.discardButton', 'Discard'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    })
  }

  /** Obsidian traps Tab within the modal; only the initial focus is ours. */
  private focusInitialElement(): void {
    if (!this.contentEl.isConnected) return
    if (this.mode === 'create' && this.createEditor) {
      this.createEditor.focus()
      return
    }
    this.contentEl.querySelector<HTMLElement>('.recipe-search-input')?.focus()
  }

  private getTaskTitle(): string {
    return this.options.instance.task.displayTitle ?? this.options.instance.task.name ?? ''
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
      new Notice(t('recipes.select.notices.loadFailed', 'Failed to load recipes'))
      this.forceClose()
    }
  }

  private async assign(recipe: Recipe): Promise<boolean> {
    try {
      await this.options.service.assignRecipeToTask(this.options.instance.task.path, recipe.path)
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to assign recipe', error)
      new Notice(t('recipes.select.notices.assignFailed', 'Failed to set recipe'))
      return false
    }

    this.forceClose()
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
      new Notice(t('recipes.select.notices.unassignFailed', 'Failed to remove recipe'))
      return
    }

    this.forceClose()
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
      new Notice(error instanceof Error ? error.message : t('recipes.select.notices.createFailed', 'Failed to create recipe'))
    }
  }
}
