import { Notice, Platform } from 'obsidian'
import type { RecipeProgressEntry, TaskInstance } from '../../../types'
import { Recipe, RecipeService, RecipeStep, createRecipeProgressKeyForInstance } from '../services/RecipeService'
import { t } from '../../../i18n'

export interface RecipeRunPopoverHost {
  service: RecipeService
  getDateKey: () => string
  getProgress: (key: string, dateKey: string) => RecipeProgressEntry | undefined
  setProgress: (key: string, progress: RecipeProgressEntry, dateKey: string) => void
  openRecipeEditor: (path: string) => void
  onProgressChanged: () => void
}

export class RecipeRunPopover {
  private popover: HTMLElement | null = null
  private outsideHandler: ((event: MouseEvent | TouchEvent) => void) | null = null
  private draggedStepIndex: number | null = null
  private showToken = 0

  constructor(private readonly host: RecipeRunPopoverHost) {}

  close(): void {
    this.showToken += 1
    this.popover?.remove()
    this.popover = null
    if (this.outsideHandler) {
      document.removeEventListener('click', this.outsideHandler)
      document.removeEventListener('touchend', this.outsideHandler)
      this.outsideHandler = null
    }
  }

  async show(instance: TaskInstance, anchor: HTMLElement): Promise<void> {
    this.close()
    const token = this.showToken
    const recipePath = instance.task.recipePath
    if (!recipePath) return
    const dateKey = this.host.getDateKey()

    let recipe: Recipe
    try {
      recipe = await this.host.service.loadRecipe(recipePath)
    } catch (error) {
      if (token !== this.showToken) return
      console.error('[RecipeRunPopover] Failed to load recipe', error)
      new Notice(t('recipes.run.notices.loadFailed', 'レシピを読み込めませんでした'))
      return
    }
    if (token !== this.showToken) return

    const progressKey = createRecipeProgressKeyForInstance(instance, recipe.path)
    const current = this.host.getProgress(progressKey, dateKey)
    const checked = new Set(current?.checkedStepIds ?? [])
    const completedAtByStepId = { ...(current?.completedAtByStepId ?? {}) }
    let stepOrder = this.normalizeStepOrder(recipe.steps, current?.stepOrder)

    const popover = createDiv()
    popover.className = Platform?.isMobile
      ? 'recipe-run-popover recipe-run-popover--mobile'
      : 'recipe-run-popover taskchute-tooltip'
    this.popover = popover

    const renderBody = () => {
      popover.empty()
      const header = popover.createDiv( { cls: 'recipe-run-header' })
      const titleRow = header.createDiv( { cls: 'recipe-run-title-row' })
      titleRow.createDiv( { cls: 'recipe-run-title', text: recipe.title })
      const editButton = header.createEl('button', {
        cls: 'recipe-run-edit-button',
        attr: {
          type: 'button',
          title: t('recipes.run.editRecipe', 'レシピを編集'),
          'aria-label': t('recipes.run.editRecipe', 'レシピを編集'),
        },
      })
      this.appendEditIcon(editButton)
      editButton.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.close()
        this.host.openRecipeEditor(recipe.path)
      })

      const list = popover.createDiv( { cls: 'recipe-run-steps' })
      const displaySteps = this.applyStepOrder(recipe.steps, stepOrder)
      if (displaySteps.length === 0) {
        list.createDiv( { cls: 'recipe-empty-state', text: t('recipes.run.emptySteps', '手順がありません') })
      }
      displaySteps.forEach((step, index) => {
        const row = list.createDiv( { cls: 'recipe-run-step', attr: { 'data-step-index': String(index) } })
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
          stepOrder = this.reorderStepOrder(displaySteps, fromIndex, index)
          this.saveProgress(recipe, progressKey, dateKey, checked, stepOrder, completedAtByStepId)
          this.host.onProgressChanged()
          renderBody()
        })
        const handle = row.createEl('button', {
          cls: 'recipe-step-drag-handle',
          attr: {
            type: 'button',
            draggable: 'true',
            title: t('recipes.run.reorderStep', 'ドラッグして並び替え'),
            'aria-label': t('recipes.run.reorderStep', 'ドラッグして並び替え'),
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
          list.querySelectorAll('.recipe-run-step--drop-target')
            .forEach((element) => element.classList.remove('recipe-run-step--drop-target'))
        })
        const label = row.createEl('label', { cls: 'recipe-run-step-check' })
        const checkbox = label.createEl('input', { attr: { type: 'checkbox' } })
        checkbox.checked = checked.has(step.id)
        label.createSpan( { cls: 'recipe-run-step-text', text: step.text })
        checkbox.addEventListener('change', () => {
          const now = Date.now()
          if (checkbox.checked) {
            checked.add(step.id)
            if (!completedAtByStepId[step.id]) {
              completedAtByStepId[step.id] = new Date(now).toISOString()
            }
          } else {
            checked.delete(step.id)
            delete completedAtByStepId[step.id]
          }
          this.saveProgress(recipe, progressKey, dateKey, checked, stepOrder, completedAtByStepId, now)
          this.host.onProgressChanged()
          renderBody()
        })
      })
    }

    renderBody()
    document.body.appendChild(popover)
    this.position(anchor, popover)

    const openTime = Date.now()
    this.outsideHandler = (event: MouseEvent | TouchEvent) => {
      if (Date.now() - openTime < 150) return
      const target = event.target as Node | null
      if (target && (popover.contains(target) || target === anchor)) return
      this.close()
    }
    document.addEventListener('click', this.outsideHandler)
    document.addEventListener('touchend', this.outsideHandler)
  }

  private appendDragHandleIcon(container: HTMLElement): void {
    const svg = createSvg('svg')
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
      const circle = createSvg('circle')
      circle.setAttribute('cx', cx)
      circle.setAttribute('cy', cy)
      circle.setAttribute('r', '1.5')
      svg.appendChild(circle)
    })
    container.appendChild(svg)
  }

  private appendEditIcon(container: HTMLElement): void {
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
    path.setAttribute('d', 'M12 20h9')
    const pencil = createSvg('path')
    pencil.setAttribute('d', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')
    svg.append(path, pencil)
    container.appendChild(svg)
  }

  private normalizeStepOrder(steps: RecipeStep[], savedOrder: string[] | undefined): string[] {
    const stepIds = new Set(steps.map((step) => step.id))
    const ordered = (savedOrder ?? []).filter((stepId) => stepIds.has(stepId))
    steps.forEach((step) => {
      if (!ordered.includes(step.id)) {
        ordered.push(step.id)
      }
    })
    return ordered
  }

  private applyStepOrder(steps: RecipeStep[], stepOrder: string[]): RecipeStep[] {
    const byId = new Map(steps.map((step) => [step.id, step]))
    return this.normalizeStepOrder(steps, stepOrder)
      .map((stepId) => byId.get(stepId))
      .filter((step): step is RecipeStep => Boolean(step))
  }

  private reorderStepOrder(displaySteps: RecipeStep[], fromIndex: number, toIndex: number): string[] {
    if (toIndex < 0 || toIndex >= displaySteps.length || fromIndex === toIndex) {
      return displaySteps.map((step) => step.id)
    }
    const nextSteps = [...displaySteps]
    const [moved] = nextSteps.splice(fromIndex, 1)
    if (!moved) return displaySteps.map((step) => step.id)
    nextSteps.splice(toIndex, 0, moved)
    return nextSteps.map((step) => step.id)
  }

  private saveProgress(
    recipe: Recipe,
    progressKey: string,
    dateKey: string,
    checked: Set<string>,
    stepOrder: string[],
    completedAtByStepId: Record<string, string>,
    updatedAt: number = Date.now(),
  ): void {
    const checkedStepIds = Array.from(checked)
    const checkedCompletedAtByStepId = Object.fromEntries(
      checkedStepIds
        .map((stepId) => [stepId, completedAtByStepId[stepId]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
    )
    this.host.setProgress(progressKey, {
      recipePath: recipe.path,
      checkedStepIds,
      stepOrder: this.normalizeStepOrder(recipe.steps, stepOrder),
      completedAtByStepId: checkedCompletedAtByStepId,
      updatedAt,
    }, dateKey)
  }

  private position(anchor: HTMLElement, popover: HTMLElement): void {
    if (Platform?.isMobile) {
      return
    }
    popover.classList.add('is-measuring')
    const rect = anchor.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()
    let top = rect.bottom + 6
    if (top + popoverRect.height > window.innerHeight) {
      top = Math.max(rect.top - popoverRect.height - 6, 0)
    }
    let left = rect.left
    if (left + popoverRect.width > window.innerWidth) {
      left = Math.max(window.innerWidth - popoverRect.width - 10, 0)
    }
    popover.style.setProperty('--taskchute-tooltip-left', `${left}px`)
    popover.style.setProperty('--taskchute-tooltip-top', `${top}px`)
    popover.classList.remove('is-measuring')
  }
}
