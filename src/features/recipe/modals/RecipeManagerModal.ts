import { App, Modal, Notice } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import { Recipe, RecipeService, normalizeRecipeReference } from '../services/RecipeService'
import { renderRecipeEmptyState } from '../ui/RecipeEmptyState'
import { t } from '../../../i18n'
import { RecipeEditorForm, RecipeEditorValue } from '../ui/RecipeEditorForm'
import { showConfirmModal } from '../../../ui/modals/ConfirmModal'
import { createModalFooter } from '../../../ui/components/modalFooter'

let recipeManagerModalId = 0

type Mode = 'list' | 'edit'

export interface RecipeManagerModalOptions {
  initialRecipePath?: string
  onRecipesChanged?: () => Promise<void> | void
}

export default class RecipeManagerModal extends Modal {
  private readonly service: RecipeService
  private recipes: Recipe[] = []
  private mode: Mode = 'list'
  private editing: Recipe | null = null
  private searchQuery = ''
  private pendingInitialRecipePath: string | undefined
  private directEditFromRecipePath = false
  private activeEditor: RecipeEditorForm | null = null
  private readonly dialogTitleId: string
  /** Set once the discard prompt has been answered, so `close()` lets go. */
  private closeConfirmed = false

  constructor(app: App, plugin: TaskChutePluginLike, private readonly options: RecipeManagerModalOptions = {}) {
    super(app)
    recipeManagerModalId += 1
    this.dialogTitleId = `taskchute-recipe-manager-title-${recipeManagerModalId}`
    this.service = new RecipeService(plugin)
    this.pendingInitialRecipePath = options.initialRecipePath
  }

  onOpen(): void {
    this.modalEl.addClass('taskchute-modal', 'recipe-modal-content')
    // Obsidian does not mark the frame up as a dialog, so keep the roles the
    // hand-rolled overlay used to carry.
    this.modalEl.setAttribute('role', 'dialog')
    this.modalEl.setAttribute('aria-modal', 'true')
    this.modalEl.setAttribute('aria-labelledby', this.dialogTitleId)
    void this.reload()
  }

  /**
   * Escape, the close glyph and a backdrop click all route through `close()`,
   * so guarding it here is what keeps an in-progress edit from being discarded
   * silently. Obsidian's `setCloseCallback` fires after the fact and cannot
   * hold the dialog open, which is why this overrides `close()` instead.
   */
  close(): void {
    if (this.closeConfirmed || !this.activeEditor?.isDirty()) {
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
    this.activeEditor?.destroy()
    this.activeEditor = null
    this.contentEl.empty()
  }

  private async reload(): Promise<void> {
    try {
      this.recipes = await this.service.loadRecipes()
      const initialRecipePath = this.pendingInitialRecipePath
      if (initialRecipePath) {
        const normalizedInitialPath = normalizeRecipeReference(initialRecipePath)
        const recipe = this.recipes.find((item) => item.path === normalizedInitialPath)
        if (recipe) {
          this.editing = recipe
          this.mode = 'edit'
          this.directEditFromRecipePath = true
        }
        this.pendingInitialRecipePath = undefined
      }
      this.render()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to load recipes', error)
      new Notice(t('recipes.manager.notices.loadFailed', 'Failed to load recipe manager'))
    }
  }

  private render(): void {
    // Re-rendering discards the form, so a reorder still in flight has to go
    // with it -- its ghost is on `body` and would otherwise be orphaned.
    this.activeEditor?.destroy()
    this.activeEditor = null
    this.contentEl.empty()
    if (this.mode === 'edit') {
      this.renderEdit()
    } else {
      this.renderList()
    }
    const ownerWindow = this.contentEl.ownerDocument.defaultView ?? activeWindow
    ownerWindow.setTimeout(() => this.focusInitialElement(), 0)
  }

  private renderList(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.manager.listTitle', 'Recipes'))

    if (this.recipes.length > 0) {
      const toolbar = this.contentEl.createDiv( { cls: 'recipe-list-toolbar' })
      const search = toolbar.createEl('input', {
        cls: 'form-input recipe-search-input',
        attr: { type: 'search', placeholder: t('recipes.manager.searchPlaceholder', 'Search recipes') },
      })
      search.value = this.searchQuery
      search.addEventListener('input', () => {
        this.searchQuery = search.value
        this.renderListBody()
      })
      const createButton = toolbar.createEl('button', {
        cls: 'form-button create',
        text: t('recipes.manager.createButton', 'New'),
        attr: { type: 'button' },
      })
      createButton.addEventListener('click', () => {
        this.editing = null
        this.mode = 'edit'
        this.directEditFromRecipePath = false
        this.render()
      })
    }

    this.contentEl.createDiv( { cls: 'recipe-manager-list' })
    this.renderListBody()
  }

  private renderListBody(): void {
    const list = this.contentEl?.querySelector<HTMLElement>('.recipe-manager-list')
    if (!list) return
    list.empty()
    const query = this.searchQuery.trim().toLowerCase()
    const recipes = this.recipes.filter((recipe) => {
      if (!query) return true
      return recipe.title.toLowerCase().includes(query) || recipe.path.toLowerCase().includes(query)
    })
    if (this.recipes.length === 0) {
      renderRecipeEmptyState(list, {
        onCreate: () => {
          this.editing = null
          this.mode = 'edit'
          this.directEditFromRecipePath = false
          this.render()
        },
      })
      return
    }
    if (recipes.length === 0) {
      list.createDiv( { cls: 'recipe-empty-state', text: t('recipes.manager.noMatches', 'No matching recipes') })
      return
    }
    recipes.forEach((recipe) => {
      this.renderRecipeCard(list, recipe)
    })
  }

  private renderRecipeCard(list: HTMLElement, recipe: Recipe): void {
    const usages = this.service.findUsages(recipe.path)
    const card = list.createDiv( { cls: 'recipe-card' })
    const main = card.createDiv( { cls: 'recipe-card-main' })
    const titleRow = main.createDiv( { cls: 'recipe-card-title-row' })
    titleRow.createDiv( { cls: 'recipe-card-title', text: recipe.title })
    const openSourceButton = titleRow.createEl('button', {
      cls: 'recipe-source-open-button',
      attr: {
        type: 'button',
        title: t('recipes.manager.openSource', 'Open recipe source'),
        'aria-label': t('recipes.manager.openSource', 'Open recipe source'),
      },
    })
    this.appendOpenSourceIcon(openSourceButton)
    openSourceButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.openRecipeSource(recipe.path)
    })
    main.createDiv( {
      cls: 'recipe-card-meta',
      text: t('recipes.manager.cardMeta', '{steps} steps · {quality} quality checks / used by {usages} tasks', {
        steps: recipe.steps.length,
        quality: recipe.qualityChecks?.length ?? 0,
        usages: usages.length,
      }),
    })
    const preview = recipe.goal?.trim()
      || recipe.steps.slice(0, 3).map((step) => step.text).join(' / ')
    main.createDiv({
      cls: 'recipe-card-preview',
      text: preview || t('recipes.manager.emptyPreview', 'No recipe content'),
    })
    const actions = card.createDiv( { cls: 'recipe-card-actions' })
    const editButton = actions.createEl('button', {
      cls: 'form-button cancel recipe-card-edit-button',
      text: t('recipes.manager.editButton', 'Edit'),
      attr: { type: 'button' },
    })
    editButton.addEventListener('click', () => {
      this.editing = recipe
      this.mode = 'edit'
      this.directEditFromRecipePath = false
      this.render()
    })
    const deleteButton = actions.createEl('button', {
      cls: 'recipe-card-delete-button',
      attr: {
        type: 'button',
        title: t('recipes.manager.deleteRecipe', 'Delete recipe'),
        'aria-label': t('recipes.manager.deleteRecipe', 'Delete recipe'),
      },
    })
    this.appendTrashIcon(deleteButton)
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.confirmDeleteRecipe(recipe)
    })
  }

  private renderEdit(): void {
    if (!this.contentEl) return
    const recipe = this.editing

    this.renderHeader(
      recipe ? t('recipes.manager.editTitle', 'Edit recipe') : t('recipes.manager.createTitle', 'Create recipe'),
    )

    const form = this.contentEl.createEl('form', { cls: 'task-form recipe-edit-form' })
    const editor = new RecipeEditorForm(form, {
      title: recipe?.title,
      goal: recipe?.goal,
      steps: recipe?.steps,
      qualityChecks: recipe?.qualityChecks,
      constraints: recipe?.constraints,
    })
    this.activeEditor = editor

    let saveButton: HTMLButtonElement | undefined
    createModalFooter(form, [
      {
        text: t('common.cancel', 'Cancel'),
        role: 'cancel',
        onClick: () => {
          void this.requestLeaveEdit()
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
      if (!editor.validate() || !saveButton) return
      const button = saveButton
      button.disabled = true
      void this.saveCurrentRecipe(recipe?.path, editor.getValue())
        .finally(() => {
          button.disabled = false
        })
    })
  }

  private renderHeader(title: string): void {
    this.setTitle(title)
    this.titleEl.id = this.dialogTitleId
  }

  private async requestLeaveEdit(): Promise<void> {
    if (this.activeEditor?.isDirty()) {
      const confirmed = await this.confirmDiscardChanges()
      if (!confirmed) return
    }
    if (this.directEditFromRecipePath) {
      this.forceClose()
      return
    }
    this.mode = 'list'
    this.editing = null
    this.render()
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
    if (this.mode === 'edit' && this.activeEditor) {
      this.activeEditor.focus()
      return
    }
    this.contentEl.querySelector<HTMLElement>('.recipe-search-input')?.focus()
  }

  private appendOpenSourceIcon(container: HTMLElement): void {
    const svg = createSvg('svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const path = createSvg('path')
    path.setAttribute('d', 'M7 17L17 7')
    const arrow = createSvg('path')
    arrow.setAttribute('d', 'M9 7h8v8')
    svg.append(path, arrow)
    container.appendChild(svg)
  }

  private appendTrashIcon(container: HTMLElement): void {
    const svg = createSvg('svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const paths = [
      'M3 6h18',
      'M8 6V4h8v2',
      'M19 6l-1 14H6L5 6',
      'M10 11v5',
      'M14 11v5',
    ]
    paths.forEach((d) => {
      const path = createSvg('path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    })
    container.appendChild(svg)
  }

  private async openRecipeSource(path: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(path, '', false)
      this.forceClose()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to open recipe source', error)
      new Notice(t('recipes.manager.notices.openSourceFailed', 'Failed to open recipe source'))
    }
  }

  private async saveCurrentRecipe(path: string | undefined, value: RecipeEditorValue): Promise<void> {
    try {
      await this.service.saveRecipe({ path, ...value })
      new Notice(t('recipes.manager.notices.saved', 'Recipe saved'))
      this.directEditFromRecipePath = false
      this.mode = 'list'
      this.editing = null
      await this.reload()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to save recipe', error)
      new Notice(error instanceof Error ? error.message : t('recipes.manager.notices.saveFailed', 'Failed to save recipe'))
    }
  }

  private async deleteCurrentRecipe(recipe: Recipe): Promise<void> {
    try {
      await this.service.deleteRecipe(recipe.path)
      new Notice(t('recipes.manager.notices.deleted', 'Recipe deleted'))
      this.mode = 'list'
      this.editing = null
      await this.notifyRecipesChanged()
      await this.reload()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to delete recipe', error)
      new Notice(t('recipes.manager.notices.deleteFailed', 'Failed to delete recipe'))
    }
  }

  private async notifyRecipesChanged(): Promise<void> {
    try {
      await this.options.onRecipesChanged?.()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to notify recipe changes', error)
    }
  }

  private async confirmDeleteRecipe(recipe: Recipe): Promise<void> {
    const confirmed = await showConfirmModal(this.app, {
      title: t('routineManager.confirm.heading', 'Confirm'),
      message: t('recipes.manager.deleteConfirmTitle', 'Delete "{title}"?', {
        title: recipe.title,
      }),
      description: t(
        'recipes.manager.deleteConfirmMessage',
        'Linked tasks will also be unassigned.',
      ),
      confirmText: t('common.delete', 'Delete'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    })
    if (!confirmed) return
    await this.deleteCurrentRecipe(recipe)
  }
}
