import { App, Notice } from 'obsidian'
import type { TaskInstance } from '../../../types'
import { Recipe, RecipeService } from '../services/RecipeService'
import { renderRecipeEmptyState } from '../ui/RecipeEmptyState'
import { attachCloseButtonIcon } from '../../../ui/components/iconUtils'
import { t } from '../../../i18n'

export interface RecipeSelectModalOptions {
  service: RecipeService
  instance: TaskInstance
  onAssigned: () => Promise<void> | void
}

type Mode = 'select' | 'create'
type StepRowCallbacks = {
  onChange: () => void
  onRemove: () => void
  onReorder: (fromIndex: number, toIndex: number) => void
}

export class RecipeSelectModal {
  private recipes: Recipe[] = []
  private mode: Mode = 'select'
  private draggedStepIndex: number | null = null
  private createInitialTitle = ''
  private selectedRecipePath: string | null = null
  private listEl: HTMLElement | null = null
  private searchInput: HTMLInputElement | null = null
  private selectStepsList: HTMLElement | null = null
  private selectStepsGroup: HTMLElement | null = null
  private saveButton: HTMLButtonElement | null = null
  private suggestionsEl: HTMLElement | null = null
  private modalEl: HTMLDivElement | null = null
  private contentEl: HTMLDivElement | null = null
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null

  constructor(private readonly app: App, private readonly options: RecipeSelectModalOptions) {}

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
        this.close()
      }
    }
    document.addEventListener('keydown', this.escapeKeyHandler)
    void this.loadRecipes()
  }

  close(): void {
    if (this.escapeKeyHandler) {
      document.removeEventListener('keydown', this.escapeKeyHandler)
      this.escapeKeyHandler = null
    }
    this.modalEl?.remove()
    this.hideSuggestions()
    this.modalEl = null
    this.contentEl = null
  }

  private render(): void {
    if (!this.contentEl) return
    this.contentEl.empty()
    if (this.mode === 'create') {
      this.renderCreate()
      return
    }
    this.renderSelect()
  }

  private renderSelect(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.select.title', 'レシピを設定'), true)

    if (this.recipes.length > 0) {
      const titleGroup = this.contentEl.createEl('div', { cls: 'form-group recipe-select-name-group' })
      titleGroup.createEl('label', { cls: 'form-label', text: t('recipes.select.nameLabel', 'レシピ名:') })
      this.searchInput = this.contentEl.createEl('input', {
        cls: 'form-input recipe-search-input',
        attr: { type: 'search', placeholder: t('recipes.manager.searchPlaceholder', 'レシピを検索') },
      })
      titleGroup.appendChild(this.searchInput)
      this.searchInput.addEventListener('input', () => {
        this.selectedRecipePath = null
        this.updateSaveButton()
        this.updateSelectStepState()
        this.renderSuggestions()
      })
      this.renderInlineCreateSteps()
    } else {
      this.searchInput = null
      this.selectStepsList = null
      this.selectStepsGroup = null
    }
    this.listEl = this.contentEl.createEl('div', { cls: 'recipe-select-list recipe-select-list--empty' })
    if (this.recipes.length > 0) {
      this.renderSelectFooter()
    } else {
      renderRecipeEmptyState(this.listEl, {
        onCreate: () => {
          this.mode = 'create'
          this.render()
        },
      })
    }
  }

  private renderInlineCreateSteps(): void {
    if (!this.contentEl) return
    this.selectStepsGroup = this.contentEl.createEl('div', { cls: 'form-group recipe-select-create-steps-group' })
    this.selectStepsGroup.createEl('label', { cls: 'form-label', text: `${t('recipes.manager.stepsLabel', '手順')}:` })
    this.selectStepsList = this.selectStepsGroup.createEl('div', { cls: 'recipe-steps-list' })
    let stepValues = ['']
    const renderSteps = () => {
      if (!this.selectStepsList) return
      this.selectStepsList.empty()
      if (stepValues.length === 0) {
        stepValues = ['']
      }
      stepValues.forEach((value, index) => {
        this.appendStepRow(this.selectStepsList!, value, index, {
          onChange: () => {
            stepValues = this.collectStepValuesIncludingBlank(this.selectStepsList)
            this.updateSaveButton()
          },
          onRemove: () => {
            stepValues = this.collectStepValuesIncludingBlank(this.selectStepsList)
            if (stepValues.length === 0) {
              stepValues = ['']
            }
            renderSteps()
            this.updateSaveButton()
          },
          onReorder: (fromIndex, toIndex) => {
            stepValues = this.reorderValues(this.collectStepValuesIncludingBlank(this.selectStepsList), fromIndex, toIndex)
            renderSteps()
            this.updateSaveButton()
          },
        })
      })
    }
    renderSteps()

    const addStep = this.selectStepsGroup.createEl('button', {
      cls: 'form-button cancel recipe-add-step-button',
      text: t('recipes.manager.addStep', '+ 手順を追加'),
      attr: { type: 'button' },
    })
    addStep.addEventListener('click', () => {
      if (!this.selectStepsList) return
      stepValues = this.collectStepValuesIncludingBlank(this.selectStepsList)
      stepValues.push('')
      renderSteps()
      this.updateSaveButton()
    })
    this.updateSelectStepState()
  }

  private renderSuggestions(): void {
    this.hideSuggestions()
    if (!this.searchInput) return
    const query = this.searchInput?.value.trim().toLowerCase() ?? ''
    const recipes = this.recipes.filter((recipe) => {
      if (!query) return false
      return recipe.title.toLowerCase().includes(query) || recipe.path.toLowerCase().includes(query)
    })
    if (recipes.length === 0) return

    const suggestions = document.createElement('div')
    suggestions.className = 'taskchute-autocomplete-suggestions recipe-autocomplete-suggestions'
    recipes.slice(0, 15).forEach((recipe) => {
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      const title = document.createElement('div')
      title.className = 'suggestion-title'
      const label = document.createElement('span')
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
    document.body.appendChild(suggestions)
    this.suggestionsEl = suggestions
  }

  private renderCreate(): void {
    if (!this.contentEl) return
    this.renderHeader(t('recipes.manager.createTitle', 'レシピ新規作成'), true)

    const form = this.contentEl.createEl('form', { cls: 'task-form recipe-edit-form' })
    const titleGroup = form.createEl('div', { cls: 'form-group' })
    titleGroup.createEl('label', { cls: 'form-label', text: t('recipes.manager.nameLabel', 'レシピ名') })
    const titleInput = titleGroup.createEl('input', {
      cls: 'form-input recipe-title-input',
      attr: { type: 'text' },
    })
    titleInput.value = this.createInitialTitle

    const stepsGroup = form.createEl('div', { cls: 'form-group' })
    stepsGroup.createEl('label', { cls: 'form-label', text: t('recipes.manager.stepsLabel', '手順') })
    const stepsList = stepsGroup.createEl('div', { cls: 'recipe-steps-list' })
    let stepValues = ['']
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
      if (this.recipes.length > 0) {
        this.mode = 'select'
        this.createInitialTitle = ''
        this.render()
      } else {
        this.close()
      }
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      saveButton.disabled = true
      void this.createAndAssign(titleInput.value, this.collectStepValues(stepsList))
        .finally(() => {
          saveButton.disabled = false
        })
    })
  }

  private renderSelectFooter(): void {
    if (!this.contentEl) return
    const buttonGroup = this.contentEl.createEl('div', { cls: 'form-button-group recipe-select-footer' })
    const cancelButton = buttonGroup.createEl('button', {
      cls: 'form-button cancel',
      text: t('common.cancel', 'キャンセル'),
      attr: { type: 'button' },
    })
    this.saveButton = buttonGroup.createEl('button', {
      cls: 'form-button create recipe-select-save-button',
      text: t('recipes.manager.saveButton', '保存'),
      attr: { type: 'button' },
    })
    cancelButton.addEventListener('click', () => this.close())
    this.saveButton.addEventListener('click', () => {
      const recipe = this.resolveRecipeForSave()
      const title = this.searchInput?.value.trim() ?? ''
      if (!recipe && !title) return
      if (!recipe) {
        this.hideSuggestions()
        this.saveButton!.disabled = true
        void this.createAndAssign(title, this.collectStepValues(this.selectStepsList)).finally(() => {
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
    const hasSteps = this.collectStepValues(this.selectStepsList).length > 0
    this.saveButton.disabled = recipe ? false : title.length === 0 || !hasSteps
  }

  private selectExistingRecipe(recipe: Recipe): void {
    this.selectedRecipePath = recipe.path
    if (this.searchInput) {
      this.searchInput.value = recipe.title
    }
    this.hideSuggestions()
    this.updateSelectStepState()
    this.updateSaveButton()
  }

  private updateSelectStepState(): void {
    if (!this.selectStepsGroup) return
    const recipe = this.resolveRecipeForSave()
    this.selectStepsGroup.style.display = recipe ? 'none' : ''
  }

  private hideSuggestions(): void {
    this.suggestionsEl?.remove()
    this.suggestionsEl = null
  }

  private resolveRecipeForSave(): Recipe | undefined {
    const selected = this.recipes.find((item) => item.path === this.selectedRecipePath)
    if (selected) return selected
    const title = this.searchInput?.value.trim().toLowerCase()
    if (!title) return undefined
    return this.recipes.find((recipe) => recipe.title.trim().toLowerCase() === title)
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

  private appendStepRow(container: HTMLElement, value: string, index: number, callbacks: StepRowCallbacks): void {
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

  private collectStepValues(container: HTMLElement | null): string[] {
    if (!container) return []
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.recipe-step-input'))
    return inputs.map((input) => input.value.trim()).filter((value) => value.length > 0)
  }

  private collectStepValuesIncludingBlank(container: HTMLElement | null): string[] {
    if (!container) return []
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

  private async loadRecipes(): Promise<void> {
    try {
      this.recipes = await this.options.service.loadRecipes()
      this.render()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to load recipes', error)
      new Notice(t('recipes.select.notices.loadFailed', 'レシピ一覧の読み込みに失敗しました'))
      this.close()
    }
  }

  private async assign(recipe: Recipe): Promise<void> {
    try {
      await this.options.service.assignRecipeToTask(this.options.instance.task.path, recipe.path)
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to assign recipe', error)
      new Notice(t('recipes.select.notices.assignFailed', 'レシピの設定に失敗しました'))
      return
    }

    this.close()
    try {
      await this.options.onAssigned()
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to refresh after assigning recipe', error)
    }
  }

  private async createAndAssign(title: string, steps: string[]): Promise<void> {
    try {
      const recipe = await this.options.service.saveRecipe({ title, steps })
      await this.assign(recipe)
    } catch (error) {
      console.error('[RecipeSelectModal] Failed to create recipe', error)
      new Notice(error instanceof Error ? error.message : t('recipes.select.notices.createFailed', 'レシピの作成に失敗しました'))
    }
  }
}
