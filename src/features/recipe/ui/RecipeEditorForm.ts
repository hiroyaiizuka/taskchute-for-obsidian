import { t } from '../../../i18n'
import { applyIcon } from '../../../ui/icons'
import RecipeReorderPointerDrag, { appendRecipeDragHandleIcon } from './RecipeReorderPointerDrag'

let recipeEditorFormId = 0

export interface RecipeEditorInitialValue {
  title?: string
  goal?: string
  steps?: Array<string | { id?: string; text: string }>
  qualityChecks?: Array<string | { id?: string; text: string }>
  constraints?: Array<string | { text: string }>
}

export interface RecipeEditorValue {
  title: string
  goal: string
  steps: Array<string | { id: string; text: string }>
  qualityChecks: Array<string | { id: string; text: string }>
  constraints: string[]
}

export interface RecipeEditorFormOptions {
  showTitle?: boolean
  onChange?: (value: RecipeEditorValue) => void
}

type ChecklistKind = 'steps' | 'quality'
type EditorChecklistItem = { id?: string; text: string }

/**
 * Shared, DOM-only editor used by both the recipe manager and task assignment flow.
 * Persistence deliberately stays in the caller so the same form can later host an
 * AI-generated draft without granting the generator write access to the vault.
 */
export class RecipeEditorForm {
  private readonly fieldIdPrefix: string
  private readonly errorId: string
  private readonly showTitle: boolean
  private readonly initialValue: RecipeEditorValue
  private titleInput: HTMLInputElement | null = null
  private goalInput: HTMLTextAreaElement
  private constraintsInput: HTMLTextAreaElement
  private stepValues: EditorChecklistItem[]
  private qualityValues: EditorChecklistItem[]
  private readonly stepsList: HTMLElement
  private readonly qualityList: HTMLElement
  private errorEl: HTMLElement
  private readonly pointerDrag = new RecipeReorderPointerDrag({
    rowSelector: '.recipe-step-row',
    draggingClass: 'recipe-run-step--dragging',
    dropBeforeClass: 'recipe-run-step--drop-before',
    dropAfterClass: 'recipe-run-step--drop-after',
    ghostClass: 'recipe-reorder-drag-ghost',
    onReorder: (kind, fromIndex, toIndex) => {
      this.reorder(kind as ChecklistKind, fromIndex, toIndex)
    },
  })

  constructor(
    private readonly container: HTMLElement,
    initial: RecipeEditorInitialValue = {},
    private readonly options: RecipeEditorFormOptions = {},
  ) {
    recipeEditorFormId += 1
    this.fieldIdPrefix = `taskchute-recipe-editor-${recipeEditorFormId}`
    this.errorId = `${this.fieldIdPrefix}-error`
    this.showTitle = options.showTitle !== false
    this.initialValue = this.normalizeInitialValue(initial)
    this.stepValues = this.withBlankRow(this.toEditorItems(this.initialValue.steps))
    this.qualityValues = this.withBlankRow(this.toEditorItems(this.initialValue.qualityChecks))

    container.classList.add('recipe-editor-fields')

    if (this.showTitle) {
      const titleGroup = container.createDiv({ cls: 'form-group' })
      titleGroup.createEl('label', {
        cls: 'form-label',
        text: t('recipes.manager.nameLabel', 'レシピ名'),
        attr: { for: `${this.fieldIdPrefix}-title` },
      })
      this.titleInput = titleGroup.createEl('input', {
        cls: 'form-input recipe-title-input',
        attr: {
          type: 'text',
          id: `${this.fieldIdPrefix}-title`,
          autocomplete: 'off',
          placeholder: t('recipes.manager.namePlaceholder', 'タスクを迷わず実行できる名前'),
        },
      })
      this.titleInput.value = this.initialValue.title
      this.titleInput.addEventListener('input', () => this.handleChange())
    }

    const goalGroup = container.createDiv({ cls: 'form-group recipe-goal-group' })
    goalGroup.createEl('label', {
      cls: 'form-label',
      text: t('recipes.manager.goalLabel', '完了基準'),
      attr: { for: `${this.fieldIdPrefix}-goal` },
    })
    goalGroup.createDiv({
      cls: 'recipe-field-description',
      text: t('recipes.manager.goalDescription', 'どうなったら、このタスクを完了にできるかを記述します。'),
    })
    this.goalInput = goalGroup.createEl('textarea', {
      cls: 'form-input recipe-goal-input',
      attr: {
        rows: '3',
        id: `${this.fieldIdPrefix}-goal`,
        placeholder: t('recipes.manager.goalPlaceholder', '例: 公開前レビューを通過し、URLを共有できている'),
      },
    })
    this.goalInput.value = this.initialValue.goal
    this.goalInput.addEventListener('input', () => this.handleChange())

    const stepsGroup = container.createDiv({ cls: 'form-group recipe-checklist-group recipe-steps-group' })
    stepsGroup.createEl('label', {
      cls: 'form-label',
      text: t('recipes.manager.stepsLabel', '手順'),
    })
    stepsGroup.createDiv({
      cls: 'recipe-field-description',
      text: t('recipes.manager.stepsDescription', '実行する順番に並べます。実行時にチェックできます。'),
    })
    this.stepsList = stepsGroup.createDiv({ cls: 'recipe-steps-list' })
    this.renderChecklist('steps')
    this.appendAddButton(stepsGroup, 'steps')

    const qualityGroup = container.createDiv({ cls: 'form-group recipe-checklist-group recipe-quality-group' })
    qualityGroup.createEl('label', {
      cls: 'form-label',
      text: t('recipes.manager.qualityChecksLabel', '品質基準'),
    })
    qualityGroup.createDiv({
      cls: 'recipe-field-description',
      text: t('recipes.manager.qualityChecksDescription', '完了前に満たしているか確認する品質チェックです。'),
    })
    this.qualityList = qualityGroup.createDiv({ cls: 'recipe-quality-checks-list' })
    this.renderChecklist('quality')
    this.appendAddButton(qualityGroup, 'quality')

    const constraintsGroup = container.createDiv({ cls: 'form-group recipe-constraints-group' })
    constraintsGroup.createEl('label', {
      cls: 'form-label',
      text: t('recipes.manager.constraintsLabel', '制約・ルール'),
      attr: { for: `${this.fieldIdPrefix}-constraints` },
    })
    constraintsGroup.createDiv({
      cls: 'recipe-field-description',
      text: t('recipes.manager.constraintsDescription', '必ず守るルールを1行に1つ入力します。'),
    })
    this.constraintsInput = constraintsGroup.createEl('textarea', {
      cls: 'form-input recipe-constraints-input',
      attr: {
        rows: '4',
        id: `${this.fieldIdPrefix}-constraints`,
        placeholder: t('recipes.manager.constraintsPlaceholder', '例: 顧客データを外部サービスへ送信しない'),
      },
    })
    this.constraintsInput.value = this.initialValue.constraints.join('\n')
    this.constraintsInput.addEventListener('input', () => this.handleChange())

    this.errorEl = container.createDiv({
      cls: 'recipe-form-error',
      attr: { id: this.errorId, role: 'alert', 'aria-live': 'polite' },
    })
  }

  getValue(titleOverride?: string): RecipeEditorValue {
    return {
      title: (titleOverride ?? this.titleInput?.value ?? this.initialValue.title).trim(),
      goal: this.goalInput.value.trim(),
      steps: this.normalizeChecklistItems(this.stepValues),
      qualityChecks: this.normalizeChecklistItems(this.qualityValues),
      constraints: this.normalizeLines(this.constraintsInput.value.split(/\r?\n/u)),
    }
  }

  validate(titleOverride?: string): boolean {
    const value = this.getValue(titleOverride)
    let message = ''
    let invalidTarget: HTMLElement | null = null
    this.clearInvalidState()
    if (!value.title) {
      message = t('recipes.manager.validation.nameRequired', 'レシピ名を入力してください。')
      invalidTarget = this.titleInput
    } else if (
      !value.goal
      && value.steps.length === 0
      && value.qualityChecks.length === 0
      && value.constraints.length === 0
    ) {
      message = t(
        'recipes.manager.validation.contentRequired',
        '完了基準・手順・品質基準・制約のいずれかを入力してください。',
      )
      invalidTarget = this.goalInput
    }
    this.setError(message)
    if (message) {
      if (!value.title) {
        this.markInvalid(this.titleInput)
      } else {
        this.markInvalid(this.goalInput)
        this.container.querySelectorAll<HTMLElement>(
          '.recipe-step-input, .recipe-quality-check-input',
        ).forEach((field) => this.markInvalid(field))
        this.markInvalid(this.constraintsInput)
      }
      invalidTarget?.focus()
    }
    return message.length === 0
  }

  setError(message: string): void {
    this.errorEl.textContent = message
    this.errorEl.classList.toggle('is-visible', message.length > 0)
  }

  isDirty(titleOverride?: string): boolean {
    const value = this.getValue(titleOverride)
    return JSON.stringify(value) !== JSON.stringify({
      ...this.initialValue,
      title: (titleOverride ?? this.initialValue.title).trim(),
    })
  }

  /**
   * Abandons a reorder in flight and removes its ghost.
   *
   * The ghost is parented to `body` so it can follow the pointer, which means
   * closing the dialog mid-drag -- Escape, most easily -- would strand it on
   * screen with no pointer events left to clean it up.
   */
  destroy(): void {
    this.pointerDrag.cancel()
  }

  focus(): void {
    if (this.titleInput) {
      this.titleInput.focus()
      return
    }
    this.goalInput.focus()
  }

  private renderChecklist(kind: ChecklistKind): void {
    const list = this.getList(kind)
    const values = this.withBlankRow(this.getValues(kind))
    this.setValues(kind, values)
    list.empty()
    values.forEach((value, index) => {
      const rowClass = kind === 'steps'
        ? 'recipe-step-row'
        : 'recipe-step-row recipe-quality-check-row'
      const row = list.createDiv({ cls: rowClass })
      row.setAttribute('data-recipe-list-kind', kind)
      row.setAttribute('data-recipe-item-index', String(index))
      this.pointerDrag.registerRow(row, kind, index)

      const handleClass = kind === 'steps' ? 'recipe-step-drag-handle' : 'recipe-quality-drag-handle'
      const handle = row.createEl('button', {
        cls: `recipe-list-drag-handle ${handleClass}`,
        attr: {
          type: 'button',
          title: t('recipes.manager.reorderStep', 'ドラッグして並び替え'),
          'aria-label': t('recipes.manager.reorderStep', 'ドラッグして並び替え'),
          'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
        },
      })
      appendRecipeDragHandleIcon(handle)
      this.pointerDrag.attachHandle(handle, row)
      handle.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      handle.addEventListener('keydown', (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        const targetIndex = event.key === 'ArrowUp' ? index - 1 : index + 1
        if (targetIndex < 0 || targetIndex >= values.length) return
        this.reorder(kind, index, targetIndex)
        this.getList(kind).querySelectorAll<HTMLButtonElement>('.recipe-list-drag-handle')[targetIndex]?.focus()
      })

      const isQuality = kind === 'quality'
      const input = row.createEl('input', {
        cls: `form-input ${isQuality ? 'recipe-quality-check-input' : 'recipe-step-input'}`,
        attr: {
          type: 'text',
          'aria-label': isQuality
            ? t('recipes.manager.qualityCheckPlaceholder', '品質基準')
            : t('recipes.manager.stepPlaceholder', '手順'),
          placeholder: isQuality
            ? t('recipes.manager.qualityCheckPlaceholder', '品質基準')
            : t('recipes.manager.stepPlaceholder', '手順'),
        },
      })
      input.value = value.text
      input.addEventListener('input', () => {
        this.getValues(kind)[index] = { ...this.getValues(kind)[index], text: input.value }
        this.handleChange()
      })

      const remove = row.createEl('button', {
        cls: 'form-button cancel recipe-step-remove-button',
        attr: {
          type: 'button',
          title: isQuality
            ? t('recipes.manager.removeQualityCheck', '品質基準を削除')
            : t('recipes.manager.removeStep', '手順を削除'),
          'aria-label': isQuality
            ? t('recipes.manager.removeQualityCheck', '品質基準を削除')
            : t('recipes.manager.removeStep', '手順を削除'),
        },
      })
      applyIcon(remove, 'x')
      remove.addEventListener('click', () => {
        const next = [...this.getValues(kind)]
        next.splice(index, 1)
        this.setValues(kind, this.withBlankRow(next))
        this.renderChecklist(kind)
        this.handleChange()
      })
    })
  }

  private appendAddButton(container: HTMLElement, kind: ChecklistKind): void {
    const isQuality = kind === 'quality'
    const button = container.createEl('button', {
      cls: `form-button cancel recipe-add-step-button ${isQuality ? 'recipe-add-quality-check-button' : ''}`,
      text: isQuality
        ? t('recipes.manager.addQualityCheck', '+ 品質基準を追加')
        : t('recipes.manager.addStep', '+ 手順を追加'),
      attr: { type: 'button' },
    })
    button.addEventListener('click', () => {
      this.setValues(kind, [...this.getValues(kind), { text: '' }])
      this.renderChecklist(kind)
      const inputs = this.getList(kind).querySelectorAll<HTMLInputElement>('input[type="text"]')
      inputs[inputs.length - 1]?.focus()
      this.handleChange()
    })
  }

  private reorder(kind: ChecklistKind, fromIndex: number, toIndex: number): void {
    const values = [...this.getValues(kind)]
    if (toIndex < 0 || toIndex >= values.length || fromIndex === toIndex) return
    const [moved] = values.splice(fromIndex, 1)
    if (moved === undefined) return
    values.splice(toIndex, 0, moved)
    this.setValues(kind, values)
    this.renderChecklist(kind)
    this.handleChange()
  }

  private handleChange(): void {
    this.setError('')
    this.clearInvalidState()
    this.options.onChange?.(this.getValue())
  }

  private markInvalid(field: HTMLElement | null): void {
    if (!field) return
    field.setAttribute('aria-invalid', 'true')
    field.setAttribute('aria-describedby', this.errorId)
  }

  private clearInvalidState(): void {
    const fields: HTMLElement[] = [
      ...(this.titleInput ? [this.titleInput] : []),
      this.goalInput,
      this.constraintsInput,
      ...Array.from(this.container.querySelectorAll<HTMLElement>(
        '.recipe-step-input, .recipe-quality-check-input',
      )),
    ]
    fields.forEach((field) => {
      field.removeAttribute('aria-invalid')
      if (field.getAttribute('aria-describedby') === this.errorId) {
        field.removeAttribute('aria-describedby')
      }
    })
  }

  private getList(kind: ChecklistKind): HTMLElement {
    return kind === 'steps' ? this.stepsList : this.qualityList
  }

  private getValues(kind: ChecklistKind): EditorChecklistItem[] {
    return kind === 'steps' ? this.stepValues : this.qualityValues
  }

  private setValues(kind: ChecklistKind, values: EditorChecklistItem[]): void {
    if (kind === 'steps') {
      this.stepValues = values
    } else {
      this.qualityValues = values
    }
  }

  private withBlankRow(values: EditorChecklistItem[]): EditorChecklistItem[] {
    return values.length > 0 ? [...values] : [{ text: '' }]
  }

  private normalizeInitialValue(initial: RecipeEditorInitialValue): RecipeEditorValue {
    return {
      title: initial.title?.trim() ?? '',
      goal: initial.goal?.trim() ?? '',
      steps: this.normalizeChecklistItems(this.toEditorItems(initial.steps)),
      qualityChecks: this.normalizeChecklistItems(this.toEditorItems(initial.qualityChecks)),
      constraints: this.normalizeLines((initial.constraints ?? []).map((item) => (
        typeof item === 'string' ? item : item.text
      ))),
    }
  }

  private toEditorItems(
    items: Array<string | { id?: string; text: string }> | undefined,
  ): EditorChecklistItem[] {
    return (items ?? []).map((item) => (
      typeof item === 'string' ? { text: item } : { id: item.id, text: item.text }
    ))
  }

  private normalizeChecklistItems(
    values: EditorChecklistItem[],
  ): Array<string | { id: string; text: string }> {
    return values.reduce<Array<string | { id: string; text: string }>>((items, item) => {
      const text = item.text.trim()
      if (!text) return items
      if (item.id) {
        items.push({ id: item.id, text })
      } else {
        items.push(text)
      }
      return items
    }, [])
  }

  private normalizeLines(values: string[]): string[] {
    return values.map((value) => value.trim()).filter((value) => value.length > 0)
  }
}
