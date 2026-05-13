import { App, Notice } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import { Recipe, RecipeService, normalizeRecipeReference } from '../services/RecipeService'
import { renderRecipeEmptyState } from '../ui/RecipeEmptyState'
import { attachCloseButtonIcon } from '../../../ui/components/iconUtils'
import { t } from '../../../i18n'

type Mode = 'list' | 'edit'

class RecipeDeleteConfirmModal {
  private resolver: ((result: boolean) => void) | null = null
  private overlayEl: HTMLDivElement | null = null
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null

  constructor(
    private readonly recipe: Recipe,
  ) {}

  openAndWait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolver = resolve
      this.render()
    })
  }

  private render(): void {
    this.overlayEl = document.createElement('div')
    this.overlayEl.className = 'task-modal-overlay recipe-delete-confirm-overlay'
    const contentEl = this.overlayEl.createEl('div', { cls: 'task-modal-content recipe-delete-confirm-modal' })
    const body = contentEl.createEl('div', { cls: 'routine-confirm' })
    body.createEl('h3', { text: t('routineManager.confirm.heading', '確認') })
    body.createEl('p', {
      text: t('recipes.manager.deleteConfirmTitle', '「{title}」を削除しますか？', { title: this.recipe.title }),
    })
    body.createEl('p', { text: t('recipes.manager.deleteConfirmMessage', '紐付いているタスクからも解除されます。') })

    const buttonRow = body.createEl('div', { cls: 'routine-confirm__buttons' })
    const deleteButton = buttonRow.createEl('button', {
      text: t('common.delete', '削除'),
      cls: 'routine-confirm__button mod-danger',
      attr: { type: 'button' },
    })
    const cancelButton = buttonRow.createEl('button', {
      text: t('common.cancel', 'キャンセル'),
      cls: 'routine-confirm__button',
      attr: { type: 'button' },
    })

    deleteButton.addEventListener('click', () => {
      this.closeWith(true)
    })
    cancelButton.addEventListener('click', () => {
      this.closeWith(false)
    })

    this.overlayEl.addEventListener('click', (event) => {
      if (event.target === this.overlayEl) {
        this.closeWith(false)
      }
    })
    this.escapeKeyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeWith(false)
      }
    }
    document.addEventListener('keydown', this.escapeKeyHandler)
    document.body.appendChild(this.overlayEl)
    deleteButton.focus()
  }

  private closeWith(result: boolean): void {
    if (this.escapeKeyHandler) {
      document.removeEventListener('keydown', this.escapeKeyHandler)
      this.escapeKeyHandler = null
    }
    this.overlayEl?.remove()
    this.overlayEl = null
    if (!this.resolver) return
    const resolve = this.resolver
    this.resolver = null
    resolve(result)
  }
}

export interface RecipeManagerModalOptions {
  initialRecipePath?: string
  onRecipesChanged?: () => Promise<void> | void
}

export default class RecipeManagerModal {
  private readonly service: RecipeService
  private recipes: Recipe[] = []
  private mode: Mode = 'list'
  private editing: Recipe | null = null
  private searchQuery = ''
  private modalEl: HTMLDivElement | null = null
  private contentEl: HTMLDivElement | null = null
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null
  private draggedStepIndex: number | null = null
  private pendingInitialRecipePath: string | undefined
  private directEditFromRecipePath = false

  constructor(private readonly app: App, plugin: TaskChutePluginLike, private readonly options: RecipeManagerModalOptions = {}) {
    this.service = new RecipeService(plugin)
    this.pendingInitialRecipePath = options.initialRecipePath
  }

  open(): void {
    this.modalEl = document.createElement('div')
    this.modalEl.className = 'task-modal-overlay'
    this.contentEl = this.modalEl.createEl('div', {
      cls: 'task-modal-content routine-edit-modal recipe-modal-content',
    })
    this.modalEl.addEventListener('click', (event) => {
      if (event.target === this.modalEl) {
        this.close()
      }
    })
    document.body.appendChild(this.modalEl)
    this.escapeKeyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('.recipe-delete-confirm-overlay')) {
          return
        }
        this.close()
      }
    }
    document.addEventListener('keydown', this.escapeKeyHandler)
    void this.reload()
  }

  close(): void {
    if (this.escapeKeyHandler) {
      document.removeEventListener('keydown', this.escapeKeyHandler)
      this.escapeKeyHandler = null
    }
    this.modalEl?.remove()
    this.modalEl = null
    this.contentEl = null
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
      new Notice(t('recipes.manager.notices.loadFailed', 'レシピ管理画面の読み込みに失敗しました'))
    }
  }

  private render(): void {
    if (!this.contentEl) return
    this.contentEl.empty()
    if (this.mode === 'edit') {
      this.renderEdit()
      return
    }
    this.renderList()
  }

  private renderList(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.manager.listTitle', 'レシピ一覧'), true)

    if (this.recipes.length > 0) {
      const toolbar = this.contentEl.createEl('div', { cls: 'recipe-list-toolbar' })
      const search = toolbar.createEl('input', {
        cls: 'form-input recipe-search-input',
        attr: { type: 'search', placeholder: t('recipes.manager.searchPlaceholder', 'レシピを検索') },
      })
      search.value = this.searchQuery
      search.addEventListener('input', () => {
        this.searchQuery = search.value
        this.renderListBody()
      })
      const createButton = toolbar.createEl('button', {
        cls: 'form-button create',
        text: t('recipes.manager.createButton', '新規'),
        attr: { type: 'button' },
      })
      createButton.addEventListener('click', () => {
        this.editing = null
        this.mode = 'edit'
        this.directEditFromRecipePath = false
        this.render()
      })
    }

    this.contentEl.createEl('div', { cls: 'recipe-manager-list' })
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
      list.createEl('div', { cls: 'recipe-empty-state', text: t('recipes.manager.noMatches', '一致するレシピがありません') })
      return
    }
    recipes.forEach((recipe) => {
      this.renderRecipeCard(list, recipe)
    })
  }

  private renderRecipeCard(list: HTMLElement, recipe: Recipe): void {
    const usages = this.service.findUsages(recipe.path)
    const card = list.createEl('div', { cls: 'recipe-card' })
    const main = card.createEl('div', { cls: 'recipe-card-main' })
    const titleRow = main.createEl('div', { cls: 'recipe-card-title-row' })
    titleRow.createEl('div', { cls: 'recipe-card-title', text: recipe.title })
    const openSourceButton = titleRow.createEl('button', {
      cls: 'recipe-source-open-button',
      attr: {
        type: 'button',
        title: t('recipes.manager.openSource', 'レシピ原本を開く'),
        'aria-label': t('recipes.manager.openSource', 'レシピ原本を開く'),
      },
    })
    this.appendOpenSourceIcon(openSourceButton)
    openSourceButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.openRecipeSource(recipe.path)
    })
    main.createEl('div', {
      cls: 'recipe-card-meta',
      text: t('recipes.manager.cardMeta', '{steps} 手順 / 使用中: {usages} タスク', {
        steps: recipe.steps.length,
        usages: usages.length,
      }),
    })
    const preview = recipe.steps.slice(0, 3).map((step) => step.text).join(' / ')
    main.createEl('div', { cls: 'recipe-card-preview', text: preview || t('recipes.manager.emptyPreview', '手順なし') })
    const actions = card.createEl('div', { cls: 'recipe-card-actions' })
    const editButton = actions.createEl('button', {
      cls: 'form-button cancel recipe-card-edit-button',
      text: t('recipes.manager.editButton', '編集'),
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
        title: t('recipes.manager.deleteRecipe', 'レシピを削除'),
        'aria-label': t('recipes.manager.deleteRecipe', 'レシピを削除'),
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
      recipe ? t('recipes.manager.editTitle', 'レシピ編集') : t('recipes.manager.createTitle', 'レシピ新規作成'),
      true,
    )

    const form = this.contentEl.createEl('form', { cls: 'task-form recipe-edit-form' })
    const titleGroup = form.createEl('div', { cls: 'form-group' })
    titleGroup.createEl('label', { cls: 'form-label', text: t('recipes.manager.nameLabel', 'レシピ名') })
    const titleInput = titleGroup.createEl('input', {
      cls: 'form-input recipe-title-input',
      attr: { type: 'text' },
    })
    titleInput.value = recipe?.title ?? ''

    const stepsGroup = form.createEl('div', { cls: 'form-group' })
    stepsGroup.createEl('label', { cls: 'form-label', text: t('recipes.manager.stepsLabel', '手順') })
    const stepsList = stepsGroup.createEl('div', { cls: 'recipe-steps-list' })
    let stepValues = recipe?.steps.map((step) => step.text) ?? ['']

    const renderSteps = () => {
      stepsList.empty()
      if (stepValues.length === 0) {
        stepValues = ['']
      }
      stepValues.forEach((value, index) => {
        this.appendStepRow(stepsList, value, index, {
          onChange: () => {
            stepValues = this.collectStepValuesIncludingBlank(stepsList)
          },
          onRemove: () => {
            stepValues = this.collectStepValuesIncludingBlank(stepsList)
            if (stepValues.length === 0) {
              stepValues = ['']
            }
            renderSteps()
          },
          onReorder: (fromIndex, toIndex) => {
            stepValues = this.reorderValues(this.collectStepValuesIncludingBlank(stepsList), fromIndex, toIndex)
            renderSteps()
          },
        })
      })
    }

    renderSteps()

    const addStep = stepsGroup.createEl('button', {
      cls: 'form-button cancel recipe-add-step-button',
      text: t('recipes.manager.addStep', '+ 手順を追加'),
      attr: { type: 'button' },
    })
    addStep.addEventListener('click', () => {
      stepValues = this.collectStepValuesIncludingBlank(stepsList)
      stepValues.push('')
      renderSteps()
    })

    const buttonGroup = form.createEl('div', { cls: 'form-button-group' })
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
      if (this.directEditFromRecipePath) {
        this.close()
        return
      }
      this.mode = 'list'
      this.editing = null
      this.render()
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      saveButton.disabled = true
      void this.saveCurrentRecipe(recipe?.path, titleInput.value, this.collectStepValues(stepsList))
        .finally(() => {
          saveButton.disabled = false
        })
    })
  }

  private renderHeader(title: string, showClose: boolean): void {
    const header = this.contentEl?.createEl('div', { cls: 'modal-header recipe-modal-header' })
    if (!header) return
    header.createEl('h3', { text: title })
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
    closeButton.addEventListener('click', () => this.close())
  }

  private appendStepRow(
    container: HTMLElement,
    value: string,
    index: number,
    callbacks: {
      onChange: () => void
      onRemove: () => void
      onReorder: (fromIndex: number, toIndex: number) => void
    },
  ): void {
    const row = container.createEl('div', { cls: 'recipe-step-row' })
    row.addEventListener('dragover', (event) => {
      if (this.draggedStepIndex === null || this.draggedStepIndex === index) return
      event.preventDefault()
      row.classList.add('recipe-run-step--drop-target')
    })
    row.addEventListener('dragleave', () => {
      row.classList.remove('recipe-run-step--drop-target')
    })
    row.addEventListener('drop', (event) => {
      event.preventDefault()
      row.classList.remove('recipe-run-step--drop-target')
      if (this.draggedStepIndex === null) return
      const fromIndex = this.draggedStepIndex
      this.draggedStepIndex = null
      callbacks.onReorder(fromIndex, index)
    })
    const handle = row.createEl('button', {
      cls: 'recipe-step-drag-handle',
      attr: {
        type: 'button',
        draggable: 'true',
        title: t('recipes.manager.reorderStep', 'ドラッグして並び替え'),
        'aria-label': t('recipes.manager.reorderStep', 'ドラッグして並び替え'),
      },
    })
    this.appendDragHandleIcon(handle)
    handle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    handle.addEventListener('dragstart', (event) => {
      this.draggedStepIndex = index
      row.classList.add('recipe-run-step--dragging')
      event.dataTransfer?.setData('text/plain', String(index))
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
      }
    })
    handle.addEventListener('dragend', () => {
      this.draggedStepIndex = null
      row.classList.remove('recipe-run-step--dragging')
      container.querySelectorAll('.recipe-run-step--drop-target')
        .forEach((element) => element.classList.remove('recipe-run-step--drop-target'))
    })
    const input = row.createEl('input', {
      cls: 'form-input recipe-step-input',
      attr: { type: 'text', placeholder: t('recipes.manager.stepPlaceholder', '手順') },
    })
    input.value = value
    input.addEventListener('input', callbacks.onChange)
    const remove = row.createEl('button', {
      cls: 'form-button cancel recipe-step-remove-button',
      text: '×',
      attr: { type: 'button', title: t('recipes.manager.removeStep', '手順を削除') },
    })
    remove.addEventListener('click', () => {
      row.remove()
      callbacks.onRemove()
    })
  }

  private collectStepValues(container: HTMLElement, fallback: string[] = []): string[] {
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.recipe-step-input'))
    if (inputs.length === 0) {
      return fallback
    }
    return inputs.map((input) => input.value.trim()).filter((value) => value.length > 0)
  }

  private collectStepValuesIncludingBlank(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLInputElement>('.recipe-step-input'))
      .map((input) => input.value)
  }

  private reorderValues(values: string[], fromIndex: number, toIndex: number): string[] {
    if (toIndex < 0 || toIndex >= values.length || fromIndex === toIndex) return values
    const nextValues = [...values]
    const [moved] = nextValues.splice(fromIndex, 1)
    if (moved === undefined) return values
    nextValues.splice(toIndex, 0, moved)
    return nextValues
  }

  private appendDragHandleIcon(container: HTMLElement): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 12 16')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '16')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('recipe-step-drag-handle-icon')
    const dots = [
      { cx: '2', cy: '2' },
      { cx: '8', cy: '2' },
      { cx: '2', cy: '8' },
      { cx: '8', cy: '8' },
      { cx: '2', cy: '14' },
      { cx: '8', cy: '14' },
    ]
    dots.forEach(({ cx, cy }) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', cx)
      circle.setAttribute('cy', cy)
      circle.setAttribute('r', '1.5')
      svg.appendChild(circle)
    })
    container.appendChild(svg)
  }

  private appendOpenSourceIcon(container: HTMLElement): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '14')
    svg.setAttribute('height', '14')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M7 17L17 7')
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M9 7h8v8')
    svg.append(path, arrow)
    container.appendChild(svg)
  }

  private appendTrashIcon(container: HTMLElement): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
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
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    })
    container.appendChild(svg)
  }

  private async openRecipeSource(path: string): Promise<void> {
    try {
      await this.app.workspace.openLinkText(path, '', false)
      this.close()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to open recipe source', error)
      new Notice(t('recipes.manager.notices.openSourceFailed', 'レシピ原本を開けませんでした'))
    }
  }

  private async saveCurrentRecipe(path: string | undefined, title: string, steps: string[]): Promise<void> {
    try {
      await this.service.saveRecipe({ path, title, steps })
      new Notice(t('recipes.manager.notices.saved', 'レシピを保存しました'))
      this.directEditFromRecipePath = false
      this.mode = 'list'
      this.editing = null
      await this.reload()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to save recipe', error)
      new Notice(error instanceof Error ? error.message : t('recipes.manager.notices.saveFailed', 'レシピの保存に失敗しました'))
    }
  }

  private async deleteCurrentRecipe(recipe: Recipe): Promise<void> {
    try {
      await this.service.deleteRecipe(recipe.path)
      new Notice(t('recipes.manager.notices.deleted', 'レシピを削除しました'))
      this.mode = 'list'
      this.editing = null
      await this.notifyRecipesChanged()
      await this.reload()
    } catch (error) {
      console.error('[RecipeManagerModal] Failed to delete recipe', error)
      new Notice(t('recipes.manager.notices.deleteFailed', 'レシピの削除に失敗しました'))
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
    const confirmed = await new RecipeDeleteConfirmModal(recipe).openAndWait()
    if (!confirmed) return
    await this.deleteCurrentRecipe(recipe)
  }
}
