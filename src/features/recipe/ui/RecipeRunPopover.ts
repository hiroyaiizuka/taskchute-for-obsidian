import { Notice, Platform } from 'obsidian'
import type { RecipeProgressEntry, TaskInstance } from '../../../types'
import {
  Recipe,
  RecipeQualityCheck,
  RecipeService,
  RecipeStep,
  createRecipeProgressKeyForInstance,
} from '../services/RecipeService'
import { t } from '../../../i18n'
import RecipeReorderPointerDrag, { appendRecipeDragHandleIcon } from './RecipeReorderPointerDrag'

let recipeRunPopoverId = 0

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
  private outsideHandlerDocument: Document | null = null
  private showToken = 0
  private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null
  private escapeKeyDocument: Document | null = null
  private anchor: HTMLElement | null = null
  private popoverId: string | null = null
  private pointerDrag: RecipeReorderPointerDrag | null = null

  constructor(private readonly host: RecipeRunPopoverHost) {}

  close(restoreAnchorFocus = false): void {
    this.showToken += 1
    // Escape can land mid-drag. The ghost lives on `body`, so removing the
    // popover alone would leave it behind with no pointer events coming.
    this.pointerDrag?.cancel()
    this.pointerDrag = null
    this.popover?.remove()
    this.popover = null
    if (this.outsideHandler) {
      const listenerDocument = this.outsideHandlerDocument ?? activeDocument
      listenerDocument.removeEventListener('click', this.outsideHandler)
      listenerDocument.removeEventListener('touchend', this.outsideHandler)
      this.outsideHandler = null
      this.outsideHandlerDocument = null
    }
    if (this.escapeKeyHandler) {
      const listenerDocument = this.escapeKeyDocument ?? activeDocument
      listenerDocument.removeEventListener('keydown', this.escapeKeyHandler)
      this.escapeKeyHandler = null
      this.escapeKeyDocument = null
    }
    const anchor = this.anchor
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false')
      if (this.popoverId && anchor.getAttribute('aria-controls') === this.popoverId) {
        anchor.removeAttribute('aria-controls')
      }
      if (restoreAnchorFocus && anchor.isConnected) {
        anchor.focus()
      }
    }
    this.anchor = null
    this.popoverId = null
  }

  async show(instance: TaskInstance, anchor: HTMLElement): Promise<void> {
    this.close()
    const token = this.showToken
    const ownerDocument = anchor.ownerDocument ?? activeDocument
    anchor.setAttribute('aria-haspopup', 'dialog')
    anchor.setAttribute('aria-expanded', 'false')
    const recipePath = instance.task.recipePath
    if (!recipePath) return
    const dateKey = this.host.getDateKey()

    let recipe: Recipe
    try {
      recipe = await this.host.service.loadRecipe(recipePath)
    } catch (error) {
      if (token !== this.showToken) return
      console.error('[RecipeRunPopover] Failed to load recipe', error)
      new Notice(t('recipes.run.notices.loadFailed', 'Failed to load recipe'))
      return
    }
    if (token !== this.showToken) return

    const progressKey = createRecipeProgressKeyForInstance(instance, recipe.path)
    const current = this.host.getProgress(progressKey, dateKey)
    const checked = new Set(current?.checkedStepIds ?? [])
    const completedAtByStepId = { ...(current?.completedAtByStepId ?? {}) }
    let stepsUpdatedAt = current?.stepsUpdatedAt
    let stepOrder = this.normalizeStepOrder(recipe.steps, current?.stepOrder)
    const checkedQuality = new Set(current?.checkedQualityCheckIds ?? [])
    const completedAtByQualityCheckId = { ...(current?.completedAtByQualityCheckId ?? {}) }
    let qualityChecksUpdatedAt = current?.qualityChecksUpdatedAt
    let qualityCheckOrder = this.normalizeStepOrder(
      recipe.qualityChecks ?? [],
      current?.qualityCheckOrder,
    )

    const popover = createDiv()
    recipeRunPopoverId += 1
    const popoverId = `taskchute-recipe-run-popover-${recipeRunPopoverId}`
    const titleId = `${popoverId}-title`
    popover.id = popoverId
    popover.setAttribute('role', 'dialog')
    popover.setAttribute('aria-modal', 'false')
    popover.setAttribute('aria-labelledby', titleId)
    popover.setAttribute('tabindex', '-1')
    popover.className = Platform?.isMobile
      ? 'recipe-run-popover recipe-run-popover--mobile'
      : 'recipe-run-popover taskchute-tooltip'
    this.popover = popover
    this.anchor = anchor
    this.popoverId = popoverId

    // Rewritten on every render so a drop always reorders the rows the user can
    // actually see, not the ones that were on screen when the popover opened.
    const reorderByKind = new Map<string, (fromIndex: number, toIndex: number) => void>()
    const pointerDrag = new RecipeReorderPointerDrag({
      rowSelector: '.recipe-run-step',
      draggingClass: 'recipe-run-step--dragging',
      dropBeforeClass: 'recipe-run-step--drop-before',
      dropAfterClass: 'recipe-run-step--drop-after',
      ghostClass: 'recipe-reorder-drag-ghost',
      onReorder: (kind, fromIndex, toIndex) => reorderByKind.get(kind)?.(fromIndex, toIndex),
    })
    this.pointerDrag = pointerDrag

    const renderBody = () => {
      popover.empty()
      reorderByKind.clear()
      const header = popover.createDiv( { cls: 'recipe-run-header' })
      const titleRow = header.createDiv( { cls: 'recipe-run-title-row' })
      titleRow.createDiv( {
        cls: 'recipe-run-title',
        text: recipe.title,
        attr: { id: titleId },
      })
      const editButton = header.createEl('button', {
        cls: 'recipe-run-edit-button',
        attr: {
          type: 'button',
          title: t('recipes.run.editRecipe', 'Edit recipe'),
          'aria-label': t('recipes.run.editRecipe', 'Edit recipe'),
        },
      })
      this.appendEditIcon(editButton)
      editButton.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.close()
        this.host.openRecipeEditor(recipe.path)
      })

      if (recipe.goal?.trim()) {
        const goalSection = popover.createDiv({ cls: 'recipe-run-context recipe-run-goal' })
        goalSection.createDiv({
          cls: 'recipe-run-context-title',
          text: t('recipes.run.goalLabel', 'Definition of done'),
        })
        goalSection.createDiv({ cls: 'recipe-run-context-text', text: recipe.goal.trim() })
      }

      const renderChecklist = (
        kind: 'steps' | 'quality',
        items: Array<RecipeStep | RecipeQualityCheck>,
        checkedIds: Set<string>,
        order: string[],
        completedAt: Record<string, string>,
      ) => {
        const section = popover.createDiv({ cls: `recipe-run-section recipe-run-section--${kind}` })
        const sectionHeader = section.createDiv({ cls: 'recipe-run-section-header' })
        sectionHeader.createDiv({
          cls: 'recipe-run-section-title',
          text: kind === 'steps'
            ? t('recipes.run.stepsLabel', 'Steps')
            : t('recipes.run.qualityChecksLabel', 'Quality checks'),
        })
        sectionHeader.createSpan({
          cls: 'recipe-run-section-summary',
          text: t('recipes.run.progress', '{checked}/{total}', {
            checked: items.filter((item) => checkedIds.has(item.id)).length,
            total: items.length,
          }),
        })

        const list = section.createDiv({
          cls: kind === 'steps' ? 'recipe-run-steps' : 'recipe-run-quality-checks',
        })
        const displayItems = this.applyStepOrder(items, order)
        const commitReorder = (fromIndex: number, toIndex: number): void => {
          const nextOrder = this.reorderStepOrder(displayItems, fromIndex, toIndex)
          const now = Date.now()
          if (kind === 'steps') {
            stepOrder = nextOrder
            stepsUpdatedAt = now
          } else {
            qualityCheckOrder = nextOrder
            qualityChecksUpdatedAt = now
          }
          this.saveProgress(
            recipe,
            progressKey,
            dateKey,
            checked,
            stepOrder,
            completedAtByStepId,
            checkedQuality,
            qualityCheckOrder,
            completedAtByQualityCheckId,
            stepsUpdatedAt,
            qualityChecksUpdatedAt,
            now,
          )
          this.host.onProgressChanged()
          renderBody()
        }
        reorderByKind.set(kind, commitReorder)
        if (displayItems.length === 0) {
          list.createDiv({
            cls: 'recipe-empty-state',
            text: kind === 'steps'
              ? t('recipes.run.emptySteps', 'No steps')
              : t('recipes.run.emptyQualityChecks', 'No quality checks'),
          })
        }
        displayItems.forEach((item, index) => {
          const row = list.createDiv({
            cls: kind === 'steps' ? 'recipe-run-step' : 'recipe-run-step recipe-run-quality-check',
            attr: { 'data-step-index': String(index), 'data-recipe-list-kind': kind },
          })
          pointerDrag.registerRow(row, kind, index)
          const handle = row.createEl('button', {
            cls: 'recipe-step-drag-handle',
            attr: {
              type: 'button',
              title: t('recipes.run.reorderStep', 'Drag to reorder'),
              'aria-label': t('recipes.run.reorderStep', 'Drag to reorder'),
              'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
            },
          })
          appendRecipeDragHandleIcon(handle)
          pointerDrag.attachHandle(handle, row)
          handle.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
          })
          handle.addEventListener('keydown', (event) => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
            event.preventDefault()
            const targetIndex = event.key === 'ArrowUp' ? index - 1 : index + 1
            if (targetIndex < 0 || targetIndex >= displayItems.length) return
            commitReorder(index, targetIndex)
            popover.querySelectorAll<HTMLButtonElement>(
              `.recipe-run-section--${kind} .recipe-step-drag-handle`,
            )[targetIndex]?.focus()
          })
          const label = row.createEl('label', { cls: 'recipe-run-step-check' })
          const checkbox = label.createEl('input', { attr: { type: 'checkbox' } })
          checkbox.checked = checkedIds.has(item.id)
          label.createSpan({ cls: 'recipe-run-step-text', text: item.text })
          checkbox.addEventListener('change', () => {
            const now = Date.now()
            if (kind === 'steps') {
              stepsUpdatedAt = now
            } else {
              qualityChecksUpdatedAt = now
            }
            if (checkbox.checked) {
              checkedIds.add(item.id)
              if (!completedAt[item.id]) {
                completedAt[item.id] = new Date(now).toISOString()
              }
            } else {
              checkedIds.delete(item.id)
              delete completedAt[item.id]
            }
            this.saveProgress(
              recipe,
              progressKey,
              dateKey,
              checked,
              stepOrder,
              completedAtByStepId,
              checkedQuality,
              qualityCheckOrder,
              completedAtByQualityCheckId,
              stepsUpdatedAt,
              qualityChecksUpdatedAt,
              now,
            )
            this.host.onProgressChanged()
            renderBody()
          })
        })
      }

      if (recipe.steps.length > 0) {
        renderChecklist('steps', recipe.steps, checked, stepOrder, completedAtByStepId)
      }
      if ((recipe.qualityChecks?.length ?? 0) > 0) {
        renderChecklist(
          'quality',
          recipe.qualityChecks,
          checkedQuality,
          qualityCheckOrder,
          completedAtByQualityCheckId,
        )
      }
      if (recipe.steps.length === 0 && (recipe.qualityChecks?.length ?? 0) === 0) {
        popover.createDiv({
          cls: 'recipe-empty-state',
          text: t('recipes.run.emptyChecklists', 'No checklists'),
        })
      }

      if ((recipe.constraints?.length ?? 0) > 0) {
        const constraintsSection = popover.createDiv({ cls: 'recipe-run-context recipe-run-constraints' })
        constraintsSection.createDiv({
          cls: 'recipe-run-context-title',
          text: t('recipes.run.constraintsLabel', 'Constraints and rules'),
        })
        const constraintsList = constraintsSection.createEl('ul', { cls: 'recipe-run-constraints-list' })
        recipe.constraints.forEach((constraint) => {
          constraintsList.createEl('li', { text: constraint.text })
        })
      }
    }

    renderBody()
    ownerDocument.body.appendChild(popover)
    anchor.setAttribute('aria-controls', popoverId)
    anchor.setAttribute('aria-expanded', 'true')
    this.position(anchor, popover, ownerDocument.defaultView ?? window)

    const openTime = Date.now()
    this.outsideHandler = (event: MouseEvent | TouchEvent) => {
      if (Date.now() - openTime < 150) return
      const target = event.target as Node | null
      if (target && (popover.contains(target) || target === anchor)) return
      this.close()
    }
    this.outsideHandlerDocument = ownerDocument
    ownerDocument.addEventListener('click', this.outsideHandler)
    ownerDocument.addEventListener('touchend', this.outsideHandler)
    this.escapeKeyHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      this.close(true)
    }
    this.escapeKeyDocument = ownerDocument
    ownerDocument.addEventListener('keydown', this.escapeKeyHandler)
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
    checkedQuality: Set<string>,
    qualityCheckOrder: string[],
    completedAtByQualityCheckId: Record<string, string>,
    stepsUpdatedAt: number | undefined,
    qualityChecksUpdatedAt: number | undefined,
    updatedAt: number = Date.now(),
  ): void {
    const checkedStepIds = Array.from(checked)
    const checkedCompletedAtByStepId = Object.fromEntries(
      checkedStepIds
        .map((stepId) => [stepId, completedAtByStepId[stepId]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
    )
    const checkedQualityCheckIds = Array.from(checkedQuality)
    const checkedCompletedAtByQualityCheckId = Object.fromEntries(
      checkedQualityCheckIds
        .map((checkId) => [checkId, completedAtByQualityCheckId[checkId]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
    )
    this.host.setProgress(progressKey, {
      recipePath: recipe.path,
      checkedStepIds,
      stepsUpdatedAt,
      stepOrder: this.normalizeStepOrder(recipe.steps, stepOrder),
      completedAtByStepId: checkedCompletedAtByStepId,
      checkedQualityCheckIds,
      qualityChecksUpdatedAt,
      qualityCheckOrder: this.normalizeStepOrder(recipe.qualityChecks ?? [], qualityCheckOrder),
      completedAtByQualityCheckId: checkedCompletedAtByQualityCheckId,
      updatedAt,
    }, dateKey)
  }

  private position(anchor: HTMLElement, popover: HTMLElement, ownerWindow: Window): void {
    if (Platform?.isMobile) {
      return
    }
    popover.classList.add('is-measuring')
    const rect = anchor.getBoundingClientRect()
    const popoverRect = popover.getBoundingClientRect()
    let top = rect.bottom + 6
    if (top + popoverRect.height > ownerWindow.innerHeight) {
      top = Math.max(rect.top - popoverRect.height - 6, 0)
    }
    let left = rect.left
    if (left + popoverRect.width > ownerWindow.innerWidth) {
      left = Math.max(ownerWindow.innerWidth - popoverRect.width - 10, 0)
    }
    popover.style.setProperty('--taskchute-tooltip-left', `${left}px`)
    popover.style.setProperty('--taskchute-tooltip-top', `${top}px`)
    popover.classList.remove('is-measuring')
  }
}
