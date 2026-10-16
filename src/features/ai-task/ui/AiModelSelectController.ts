import { setIcon, type App } from 'obsidian'
import type { AiModelCatalog } from '../models/AiModelCatalog'
import type { AiTaskHost } from '../types'
import { positionScrollableDropdown } from './ScrollableDropdownPositioner'

export interface AiModelSelectLabels {
  openMenu: string
  defaultModel: string
  /** Under "Default model" when the CLI's settings name no model: who decides. */
  defaultDecidedBy(host: AiTaskHost): string
  refresh: string
  refreshing: string
  fetchedAt(time: string): string
  neverFetched: string
  fetching: string
  /** `hasPrevious`: a list fetched before is shown, not the built-in one. */
  fetchFailed(hasPrevious: boolean): string
  newBadge: string
  /** Where the refresh button would be, for an agent whose CLI has no model list. */
  alwaysNewest: string
}

export interface AiModelSelectValue {
  modelId: string | null
  /** The chosen model is not in the list shown (an older task's model). */
  isUnlisted: boolean
  /** The efforts the CLI's list gives for the chosen model, when it gives them. */
  reasoningLevels?: readonly string[]
}

export interface AiModelSelectControllerOptions {
  app?: App
  doc?: Document
  host: AiTaskHost
  catalog: AiModelCatalog
  modelId?: string | null
  labels?: Partial<AiModelSelectLabels>
  onChange?: (value: AiModelSelectValue) => void
  /** For the time next to the refresh button; tests pin it. */
  formatTime?: (at: number) => string
}

const DEFAULT_LABELS: AiModelSelectLabels = {
  openMenu: 'Choose AI model',
  defaultModel: 'Default model',
  defaultDecidedBy: () => 'The CLI decides',
  refresh: 'Get the latest models',
  refreshing: 'Getting…',
  fetchedAt: (time) => `Got at ${time}`,
  neverFetched: 'Not fetched yet',
  fetching: 'Getting the latest list… you can still choose',
  fetchFailed: (hasPrevious) =>
    hasPrevious ? 'Could not get the list. Showing the previous one.' : 'Could not get the list. Showing the built-in one.',
  newBadge: 'New',
  alwaysNewest: 'Each always runs its newest version. No list to get.',
}

function defaultFormatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

let selectSequence = 0

/**
 * The AI model dropdown of the task dialog: the CLI's default, then the
 * agent's models (name, and the ID passed to `--model`), newest version of
 * each only. For an agent whose CLI lists its models, the list is asked again
 * when it is a day old as the menu opens, and on the refresh button; the time
 * it was got shows beside it. A model that newly appeared is marked new.
 *
 * Programmatic setters do not emit onChange; a user's choice does.
 */
export class AiModelSelectController {
  private readonly doc: Document
  private readonly labels: AiModelSelectLabels
  private readonly root: HTMLElement
  private readonly menuId: string
  private readonly formatTime: (at: number) => string
  private host: AiTaskHost
  private selectedModelId: string | null
  private defaultModelName: string | null = null
  private trigger: HTMLButtonElement | null = null
  private menu: HTMLElement | null = null
  private menuOpen = false
  private destroyed = false
  private readonly unsubscribe: () => void

  constructor(
    private readonly container: HTMLElement,
    private readonly options: AiModelSelectControllerOptions,
  ) {
    this.doc = options.doc ?? container.ownerDocument
    this.labels = { ...DEFAULT_LABELS, ...options.labels }
    this.formatTime = options.formatTime ?? defaultFormatTime
    this.host = options.host
    this.selectedModelId = options.modelId?.trim() || null
    this.menuId = `ai-model-select-menu-${selectSequence += 1}`
    this.root = this.doc.win.createDiv()
    this.root.className = 'ai-model-select'
    this.container.appendChild(this.root)
    this.doc.addEventListener('mousedown', this.handleDocumentMouseDown)
    this.doc.addEventListener('keydown', this.handleDocumentKeyDown)
    this.unsubscribe = options.catalog.subscribe((host) => {
      if (host === this.host) this.render()
    })
    this.render()
    this.loadDefaultModelName()
  }

  getValue(): AiModelSelectValue {
    const id = this.selectedModelId
    if (id === null) return { modelId: null, isUnlisted: false }
    const listed = this.options.catalog.find(this.host, id)
    return {
      modelId: id,
      isUnlisted: listed === undefined,
      ...(listed?.reasoningLevels ? { reasoningLevels: listed.reasoningLevels } : {}),
    }
  }

  setHost(host: AiTaskHost): void {
    if (this.destroyed || this.host === host) return
    this.host = host
    this.selectedModelId = null
    this.defaultModelName = null
    this.render()
    this.loadDefaultModelName()
  }

  setValue(modelId: string | null): void {
    if (this.destroyed) return
    this.selectedModelId = modelId?.trim() || null
    this.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribe()
    this.doc.removeEventListener('mousedown', this.handleDocumentMouseDown)
    this.doc.removeEventListener('keydown', this.handleDocumentKeyDown)
    this.root.remove()
    this.trigger = null
    this.menu = null
  }

  private loadDefaultModelName(): void {
    const host = this.host
    void this.options.catalog.defaultModel(host).then((name) => {
      if (this.destroyed || host !== this.host) return
      this.defaultModelName = name
      this.render()
    })
  }

  private render(): void {
    if (this.destroyed) return
    const catalog = this.options.catalog
    const state = catalog.state(this.host)
    this.root.replaceChildren()

    const trigger = this.doc.win.createEl('button')
    trigger.type = 'button'
    trigger.className = 'ai-model-select__trigger ai-task-model-select'
    trigger.setAttribute('aria-label', this.labels.openMenu)
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-controls', this.menuId)
    trigger.setAttribute('aria-expanded', this.menuOpen ? 'true' : 'false')
    const modelIcon = this.doc.win.createSpan()
    modelIcon.className = 'ai-model-select__trigger-icon'
    setIcon(modelIcon, 'cpu')
    const label = this.doc.win.createSpan()
    label.className = 'ai-model-select__trigger-label'
    label.textContent = this.selectedLabel()
    const chevron = this.doc.win.createSpan()
    chevron.className = 'ai-model-select__chevron'
    setIcon(chevron, 'chevron-down')
    trigger.append(modelIcon, label)
    if (this.selectedModelId === null && this.defaultModelName) {
      const sub = this.doc.win.createSpan()
      sub.className = 'ai-model-select__trigger-sub'
      sub.textContent = this.defaultModelName
      trigger.appendChild(sub)
    }
    trigger.appendChild(chevron)
    trigger.addEventListener('click', () => this.toggleMenu())

    const menu = this.doc.win.createDiv()
    menu.id = this.menuId
    menu.className = 'ai-model-select__menu'
    menu.classList.toggle('is-hidden', !this.menuOpen)
    menu.setAttribute('aria-hidden', this.menuOpen ? 'false' : 'true')

    if (state.fetching || state.failed) {
      const banner = this.doc.win.createDiv()
      banner.className = `ai-model-select__banner ${state.fetching ? 'is-fetching' : 'is-failed'}`
      banner.setAttribute('role', 'status')
      banner.textContent = state.fetching
        ? this.labels.fetching
        : this.labels.fetchFailed(state.fetchedAt !== null)
      menu.appendChild(banner)
    }

    const list = this.doc.win.createDiv()
    list.className = 'ai-model-select__list'
    list.setAttribute('role', 'listbox')
    list.appendChild(
      this.createOption({
        modelId: null,
        label: this.labels.defaultModel,
        detail: this.defaultModelName ?? this.labels.defaultDecidedBy(this.host),
      }),
    )
    // An older task's model that the list no longer has stays selectable as it is.
    const selected = this.selectedModelId
    if (selected !== null && !state.models.some((model) => model.id === selected)) {
      list.appendChild(this.createOption({ modelId: selected, label: selected, id: selected }))
    }
    for (const model of state.models) {
      list.appendChild(
        this.createOption({
          modelId: model.id,
          label: model.label,
          id: model.id,
          isNew: catalog.isNew(this.host, model.id),
        }),
      )
    }
    menu.appendChild(list)
    menu.appendChild(this.createFooter())

    this.root.append(trigger, menu)
    this.trigger = trigger
    this.menu = menu
    if (this.menuOpen) this.positionMenu()
  }

  private createFooter(): HTMLElement {
    const state = this.options.catalog.state(this.host)
    const footer = this.doc.win.createDiv()
    footer.className = 'ai-model-select__footer'
    if (!state.canFetch) {
      const note = this.doc.win.createSpan()
      note.className = 'ai-model-select__footer-note'
      note.textContent = this.labels.alwaysNewest
      footer.appendChild(note)
      return footer
    }
    const refresh = this.doc.win.createEl('button')
    refresh.type = 'button'
    refresh.className = 'ai-model-select__refresh'
    refresh.disabled = state.fetching
    const icon = this.doc.win.createSpan()
    icon.className = 'ai-model-select__refresh-icon'
    setIcon(icon, state.fetching ? 'loader' : 'refresh-cw')
    const text = this.doc.win.createSpan()
    text.textContent = state.fetching ? this.labels.refreshing : this.labels.refresh
    refresh.append(icon, text)
    refresh.addEventListener('click', () => void this.options.catalog.refresh(this.host))
    const when = this.doc.win.createSpan()
    when.className = 'ai-model-select__fetched-at'
    when.textContent = state.fetchedAt === null
      ? this.labels.neverFetched
      : this.labels.fetchedAt(this.formatTime(state.fetchedAt))
    footer.append(refresh, when)
    return footer
  }

  private createOption(option: {
    modelId: string | null
    label: string
    /** The ID passed to the CLI, shown under the name. */
    id?: string
    /** A line of text under the name instead of an ID. */
    detail?: string
    isNew?: boolean
  }): HTMLButtonElement {
    const selected = this.selectedModelId === option.modelId
    const button = this.doc.win.createEl('button')
    button.type = 'button'
    button.className = 'ai-model-select__option'
    button.classList.toggle('is-selected', selected)
    button.dataset.modelId = option.modelId ?? ''
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', selected ? 'true' : 'false')

    const text = this.doc.win.createSpan()
    text.className = 'ai-model-select__option-text'
    const titleRow = this.doc.win.createSpan()
    titleRow.className = 'ai-model-select__option-title-row'
    const title = this.doc.win.createSpan()
    title.className = 'ai-model-select__option-title'
    title.textContent = option.label
    titleRow.appendChild(title)
    if (option.isNew) {
      const badge = this.doc.win.createSpan()
      badge.className = 'ai-model-select__new'
      badge.textContent = this.labels.newBadge
      titleRow.appendChild(badge)
    }
    text.appendChild(titleRow)
    if (option.id) {
      // The end of an ID tells variants apart (-high, -fast): cut the middle when it is long.
      const id = this.doc.win.createSpan()
      id.className = 'ai-model-select__option-id'
      id.setAttribute('title', option.id)
      const cut = Math.max(0, option.id.length - 12)
      const head = this.doc.win.createSpan()
      head.className = 'ai-model-select__option-id-head'
      head.textContent = option.id.slice(0, cut)
      const tail = this.doc.win.createSpan()
      tail.className = 'ai-model-select__option-id-tail'
      tail.textContent = option.id.slice(cut)
      id.append(head, tail)
      text.appendChild(id)
    } else if (option.detail) {
      const detail = this.doc.win.createSpan()
      detail.className = 'ai-model-select__option-description'
      detail.textContent = option.detail
      text.appendChild(detail)
    }
    button.appendChild(text)
    // Like Obsidian's own menus: a check at the end of the chosen row only.
    if (selected) {
      const check = this.doc.win.createSpan()
      check.className = 'ai-model-select__selection-marker'
      setIcon(check, 'check')
      button.appendChild(check)
    }
    button.addEventListener('click', () => this.selectFromUser(option.modelId))
    return button
  }

  private toggleMenu(): void {
    if (this.menuOpen) this.closeMenu(false)
    else this.openMenu()
  }

  private openMenu(): void {
    this.menuOpen = true
    this.options.catalog.refreshIfStale(this.host)
    this.render()
  }

  private positionMenu(): void {
    if (!this.menu || !this.trigger) return
    positionScrollableDropdown({
      anchor: this.trigger,
      menu: this.menu,
      boundary: this.root.closest<HTMLElement>('.modal'),
    })
  }

  private closeMenu(focusTrigger: boolean): void {
    if (!this.menuOpen) return
    this.menuOpen = false
    this.render()
    if (focusTrigger) this.trigger?.focus()
  }

  private selectFromUser(modelId: string | null): void {
    this.selectedModelId = modelId
    if (modelId !== null) this.options.catalog.markChosen(this.host, modelId)
    this.menuOpen = false
    this.render()
    this.options.onChange?.(this.getValue())
  }

  private selectedLabel(): string {
    const id = this.selectedModelId
    if (id === null) return this.labels.defaultModel
    return this.options.catalog.find(this.host, id)?.label ?? id
  }

  private readonly handleDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target
    if (this.menuOpen && target && !this.root.contains(target as Node)) {
      this.closeMenu(false)
    }
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.menuOpen) return
    event.preventDefault()
    this.closeMenu(true)
  }
}
