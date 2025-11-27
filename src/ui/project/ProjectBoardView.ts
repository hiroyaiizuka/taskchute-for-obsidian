import { App, EventRef, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian'

import type { TaskChutePluginLike } from '../../types'
import {
  ProjectBoardItem,
  ProjectBoardStatus,
  ProjectFolderUnsetError,
} from '../../types'
import { ProjectBoardService } from '../../services/projects'
import { t } from '../../i18n'
import { createNameModal } from '../components/NameModal'

function formatDateStamp(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeBoardStatus(value: unknown): ProjectBoardStatus | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'done' || normalized === 'completed') return 'done'
  if (
    normalized === 'in-progress'
    || normalized === 'in_progress'
    || normalized === 'in progress'
  ) {
    return 'in-progress'
  }
  if (normalized === 'todo' || normalized === 'to-do' || normalized === 'not started') {
    return 'todo'
  }
  return null
}

interface OptimisticProjectState {
  status: ProjectBoardStatus
  order: number
  updated: string
  completed?: string
}

const MAX_METADATA_SYNC_ATTEMPTS = 5

export const VIEW_TYPE_PROJECT_BOARD = 'taskchute-project-board' as const

interface StatusDefinition {
  id: ProjectBoardStatus
  label: string
}

export class ProjectBoardView extends ItemView {
  private readonly plugin: TaskChutePluginLike
  private readonly boardService: ProjectBoardService
  private readonly maxCardsPerColumn = 10

  private items: ProjectBoardItem[] = []
  private statusDefs: StatusDefinition[] = []
  private loadError: Error | null = null
  private dragPath: string | null = null
  private currentDropTarget: HTMLElement | null = null
  private dragElement: HTMLElement | null = null
  private dropIndicatorCard: HTMLElement | null = null
  private dropHint: {
    status: ProjectBoardStatus
    anchorPath: string | null
    position: 'before' | 'after' | 'empty'
  } | null = null
  private expandedStatuses = new Set<ProjectBoardStatus>()
  private optimisticItems = new Map<string, OptimisticProjectState>()
  private metadataSyncWaits = new Map<string, Promise<void>>()
  private metadataSyncAttempts = new Map<string, number>()

  constructor(
    leaf: WorkspaceLeaf,
    plugin: TaskChutePluginLike,
    options: {
      boardService?: ProjectBoardService
    } = {},
  ) {
    super(leaf)
    this.plugin = plugin
    this.boardService = options.boardService ?? new ProjectBoardService(plugin)
  }

  getViewType(): string {
    return VIEW_TYPE_PROJECT_BOARD
  }

  getDisplayText(): string {
    const appWithI18n = this.plugin?.app as App & { i18n?: { translate?: (key: string) => string | undefined } }
    return appWithI18n?.i18n?.translate?.('navigation.projects')
      ?? this.plugin?.settings?.languageOverride === 'ja'
        ? 'プロジェクト'
        : 'Projects'
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onOpen(): Promise<void> {
    this.containerEl.empty()
    this.containerEl.addClass('project-board-view')

    this.loadData()
    this.render()
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onClose(): Promise<void> {
    this.containerEl.empty()
    this.containerEl.removeClass('project-board-view')
  }

  private loadData(): void {
    this.loadError = null
    this.items = []

    try {
      this.items = this.boardService.loadProjectItems()
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      this.items = []
    }

    this.statusDefs = [
      { id: 'todo', label: this.translate('projectBoard.status.todo', 'To Do') },
      { id: 'in-progress', label: this.translate('projectBoard.status.inProgress', 'In Progress') },
      { id: 'done', label: this.translate('projectBoard.status.done', 'Done') },
    ]
  }

  private translate(
    key: string,
    fallback: string,
    vars?: Record<string, string | number>,
  ): string {
    return t(key, fallback, vars)
  }

  private compareItems(a: ProjectBoardItem, b: ProjectBoardItem): number {
    if (typeof a.order === 'number' && typeof b.order === 'number') return a.order - b.order
    if (typeof a.order === 'number') return -1
    if (typeof b.order === 'number') return 1
    return a.displayTitle.localeCompare(b.displayTitle, undefined, { sensitivity: 'base' })
  }

  private render(): void {
    const container = this.containerEl
    this.clearDropState()
    container.empty()

    if (this.loadError instanceof ProjectFolderUnsetError) {
      this.renderFolderUnset(container)
      return
    }

    if (this.loadError) {
      this.renderGenericError(container, this.loadError)
      return
    }

    const header = container.createEl('div', { cls: 'project-board-view__header' })
    header.createEl('h2', { text: this.translate('projectBoard.heading', 'Project list') })

    const body = container.createEl('div', {
      cls: 'project-board-view__body',
      attr: { 'data-layout': 'fixed' },
    })
    const columnsWrapper = body.createEl('div', { cls: 'project-board-columns' })

    this.statusDefs.forEach((definition) => {
      const column = columnsWrapper.createEl('div', {
        cls: 'project-board-column',
        attr: { 'data-status': definition.id },
      })

      this.renderColumnHeader(column, definition)
      this.renderColumnCards(column, definition.id)
      this.renderColumnFooter(column, definition.id)
    })
  }

  private renderColumnHeader(parent: HTMLElement, definition: StatusDefinition): void {
    const header = parent.createEl('div', { cls: 'project-board-column__header' })
    header.createEl('span', { cls: 'project-board-column__title', text: definition.label })

    const actions = header.createEl('div', { cls: 'project-board-column__actions' })
    const addButton = actions.createEl('button', {
      cls: 'project-board-button project-board-button--add',
      text: '+',
      attr: { 'aria-label': this.translate('projectBoard.actions.addProject', 'Add new project') },
    })
    addButton.addEventListener('click', () => this.handleCreateProject(definition.id))
  }

  private renderColumnCards(parent: HTMLElement, status: ProjectBoardStatus): void {
    const list = parent.createEl('div', {
      cls: 'project-board-column__cards',
      attr: { 'data-scroll-region': 'cards' },
    })
    list.addEventListener('dragover', (event) => this.handleDragOver(event, status, list))
    list.addEventListener('dragleave', (event) => this.handleColumnDragLeave(event, list))
    list.addEventListener('drop', (event) => this.handleDrop(event, status, list))

    const cards = this.items
      .filter((item) => item.status === status)
      .sort((a, b) => this.compareItems(a, b))

    let isExpanded = this.expandedStatuses.has(status)
    if (isExpanded && cards.length <= this.maxCardsPerColumn) {
      this.expandedStatuses.delete(status)
      isExpanded = false
    }

    const visibleCards = isExpanded ? cards : cards.slice(0, this.maxCardsPerColumn)
    visibleCards.forEach((item) => {
      const card = list.createEl('button', {
        cls: 'project-board-card',
        attr: {
          'data-status': item.status,
          'data-path': item.path,
        },
      })
      card.textContent = item.displayTitle
      card.draggable = true
      card.addEventListener('dragstart', (event) => this.handleDragStart(event, item.path))
      card.addEventListener('dragend', (event) => this.handleDragEnd(event))
      card.addEventListener('dragover', (event) => this.handleCardDragOver(event, status, card, item))
      card.addEventListener('dragleave', (event) => this.handleCardDragLeave(event, card, item))
      card.addEventListener('drop', (event) => this.handleCardDrop(event, status, item, card))
      card.addEventListener('click', (event) => {
        event.preventDefault()
        void this.handleOpenProject(item)
      })
    })

    if (!isExpanded && cards.length > this.maxCardsPerColumn) {
      const loadMoreButton = list.createEl('button', {
        cls: 'project-board-column__load-more',
        text: this.translate('projectBoard.loadMore', 'Load more'),
        attr: { type: 'button' },
      })
      loadMoreButton.addEventListener('click', () => this.handleLoadMore(status))
    }
  }

  private renderColumnFooter(parent: HTMLElement, status: ProjectBoardStatus): void {
    const footer = parent.createEl('div', { cls: 'project-board-column__footer' })
    const newButton = footer.createEl('button', {
      cls: 'project-board-column__new',
      text: this.translate('projectBoard.newProject', '＋ New project'),
      attr: { 'data-status': status },
    })
    newButton.addEventListener('click', () => this.handleCreateProject(status))
  }

  private clearDropState(): void {
    this.setCardDropIndicator(null)
    this.setDropTarget(null)
    this.dropHint = null
  }

  private renderFolderUnset(parent: HTMLElement): void {
    const wrapper = parent.createEl('div', { cls: 'project-board-view__message' })
    wrapper.createEl('h3', { text: this.translate('projectBoard.errors.folderUnsetTitle', 'Project folder not configured') })
    wrapper.createEl('p', { text: this.translate('projectBoard.errors.folderUnsetBody', 'Open settings and choose a folder for your project notes before using the project board.') })
  }

  private renderGenericError(parent: HTMLElement, error: Error): void {
    const wrapper = parent.createEl('div', { cls: 'project-board-view__message' })
    wrapper.createEl('h3', { text: this.translate('projectBoard.errors.genericTitle', 'Unable to load projects') })
    wrapper.createEl('p', { text: error.message })
  }

  private handleCreateProject(status: ProjectBoardStatus): void {
    const submitLabel = this.translate('projectCreate.create', 'Create')
    const modal = createNameModal({
      title: this.translate('projectCreate.heading', 'Create project'),
      label: this.translate('projectCreate.titleLabel', 'Project title'),
      placeholder: this.translate('projectCreate.titlePlaceholder', 'e.g., Launch marketing site'),
      submitText: submitLabel,
      cancelText: t('common.cancel', 'Cancel'),
      closeLabel: this.translate('common.close', 'Close'),
    })

    const { form, input, submitButton, close } = modal

    const resetButton = () => {
      submitButton.disabled = false
      submitButton.textContent = submitLabel
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const title = input.value.trim()

      if (!title) {
        new Notice(this.translate('projectCreate.validation.title', 'Enter a project title'))
        input.focus()
        return
      }

      submitButton.disabled = true

      this.boardService.createProject({
        title,
        status,
      }).then(() => {
        this.reloadItemsPreservingState()
        close()
        this.render()
      }).catch((error: unknown) => {
        console.error('[ProjectBoard] Failed to create project', error)
        new Notice(this.translate('projectCreate.error', 'Failed to create project'))
        resetButton()
      })
    })
  }

  private async handleOpenProject(item: ProjectBoardItem): Promise<void> {
    try {
      const file = item.file ?? this.app.vault.getAbstractFileByPath(item.path)
      if (!(file instanceof TFile)) {
        throw new Error(`Project file not found: ${item.path}`)
      }

      const workspace = this.app.workspace
      const workspaceWithSplit = workspace as { splitActiveLeaf?: (direction: 'vertical' | 'horizontal') => WorkspaceLeaf | null }
      const splitFunction = workspaceWithSplit.splitActiveLeaf
      const rightLeaf: WorkspaceLeaf | null =
        typeof splitFunction === 'function'
          ? (splitFunction.call(workspace, 'vertical') as WorkspaceLeaf | null)
          : workspace.getLeaf('split')

      if (!rightLeaf) {
        throw new Error('Unable to open project note in split view')
      }

      await rightLeaf.openFile(file)
      workspace.setActiveLeaf(this.leaf)
    } catch (error) {
      console.error('[ProjectBoard] Failed to open project file:', error)
      new Notice(this.translate('projectBoard.errors.genericTitle', 'Unable to load projects'))
    }
  }

  private handleLoadMore(status: ProjectBoardStatus): void {
    this.expandedStatuses.add(status)
    this.render()
  }

  private reloadItemsPreservingState(): boolean {
    try {
      const loaded = this.boardService.loadProjectItems()
      let mutated = false

      this.items = loaded.map((item) => {
        const optimistic = this.optimisticItems.get(item.path)
        if (!optimistic) return item

        if (item.status === optimistic.status) {
          this.optimisticItems.delete(item.path)
          return item
        }

        mutated = true
        const merged: ProjectBoardItem = {
          ...item,
          status: optimistic.status,
          order: optimistic.order,
          updated: optimistic.updated,
          completed: optimistic.completed,
          frontmatter: {
            ...item.frontmatter,
            status: optimistic.status,
            order: optimistic.order,
            updated: optimistic.updated,
            ...(optimistic.completed !== undefined ? { completed: optimistic.completed } : {}),
          },
        }

        if (optimistic.completed === undefined && merged.frontmatter && 'completed' in merged.frontmatter) {
          delete (merged.frontmatter).completed
        }

        return merged
      })

      this.loadError = null
      return mutated
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error))
      return false
    }
  }

  private handleDragStart(event: DragEvent, path: string): void {
    this.dragPath = path
    if (event.currentTarget instanceof HTMLElement) {
      this.dragElement = event.currentTarget
      event.currentTarget.classList.add('project-board-card--dragging')
    } else {
      this.dragElement = null
    }
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', path)
      event.dataTransfer.effectAllowed = 'move'
    }
  }

  private handleDragOver(event: DragEvent, status: ProjectBoardStatus, target: HTMLElement): void {
    if (!event.dataTransfer) return
    const path = this.dragPath ?? event.dataTransfer.getData('text/plain')
    if (!path) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    const cards = Array.from(target.querySelectorAll<HTMLElement>('.project-board-card'))
    const pointerY = event.clientY

    let anchorCard: HTMLElement | null = null
    let anchorPath: string | null = null
    let position: 'before' | 'after' | 'empty' = 'empty'

    if (cards.length > 0) {
      for (const card of cards) {
        const rect = card.getBoundingClientRect()
        if (pointerY < rect.top) {
          anchorCard = card
          anchorPath = card.getAttribute('data-path')
          position = 'before'
          break
        }
        if (pointerY <= rect.bottom) {
          anchorCard = card
          anchorPath = card.getAttribute('data-path')
          position = pointerY < rect.top + rect.height / 2 ? 'before' : 'after'
          break
        }
      }

      if (!anchorCard) {
        const lastCard = cards[cards.length - 1]
        const rect = lastCard.getBoundingClientRect()
        const threshold = rect.bottom + 6
        anchorCard = lastCard
        anchorPath = lastCard.getAttribute('data-path')
        position = pointerY >= threshold ? 'after' : 'before'
      }
    }

    this.setDropTarget(target, {
      status,
      anchorPath,
      anchorCard,
      position,
    })
  }

  private handleColumnDragLeave(event: DragEvent, target: HTMLElement): void {
    const related = event.relatedTarget as Node | null
    if (related && target.contains(related)) return
    if (this.currentDropTarget === target) {
      this.setDropTarget(null)
    }
  }

  private handleDrop(event: DragEvent, status: ProjectBoardStatus, target: HTMLElement): void {
    event.preventDefault()
    const path = this.dragPath || event.dataTransfer?.getData('text/plain')
    if (!path) return
    const hint =
      this.dropHint && this.dropHint.status === status
        ? this.dropHint
        : (() => {
            const lastCard = target.querySelector('.project-board-card:last-of-type')
            const anchorPath = lastCard?.getAttribute('data-path') ?? null
            const position: 'before' | 'after' | 'empty' = anchorPath ? 'after' : 'empty'
            return { status, anchorPath, position }
          })()
    this.clearDropState()
    void this.handleStatusChange(path, status, hint)
  }

  private setDropTarget(
    target: HTMLElement | null,
    hint?: {
      status: ProjectBoardStatus
      anchorPath: string | null
      anchorCard?: HTMLElement | null
      position: 'before' | 'after' | 'empty'
    },
  ): void {
    if (this.currentDropTarget && this.currentDropTarget !== target) {
      this.currentDropTarget.classList.remove(
        'project-board-column__cards--drop-target',
        'project-board-column__cards--drop-target-empty',
      )
    }

    if (!target) {
      if (this.currentDropTarget) {
        this.currentDropTarget.classList.remove(
          'project-board-column__cards--drop-target',
          'project-board-column__cards--drop-target-empty',
        )
      }
      this.currentDropTarget = null
      if (!this.dropIndicatorCard) {
        this.dropHint = null
      }
      return
    }

    this.currentDropTarget = target
    target.classList.add('project-board-column__cards--drop-target')
    target.classList.remove('project-board-column__cards--drop-target-empty')
    if (hint?.position === 'empty') {
      target.classList.add('project-board-column__cards--drop-target-empty')
    }
    if (hint) {
      if (hint.position !== 'empty' && hint.anchorCard && hint.anchorPath) {
        this.setCardDropIndicator(hint.anchorCard, hint.status, hint.anchorPath, hint.position)
      } else {
        this.setCardDropIndicator(null)
      }
      this.dropHint = {
        status: hint.status,
        anchorPath: hint.anchorPath,
        position: hint.position,
      }
      return
    }

    if (!this.dropIndicatorCard) {
      this.dropHint = null
    }
  }

  private setCardDropIndicator(
    card: HTMLElement | null,
    status?: ProjectBoardStatus,
    anchorPath?: string,
    position?: 'before' | 'after',
  ): void {
    if (this.dropIndicatorCard && this.dropIndicatorCard !== card) {
      this.dropIndicatorCard.classList.remove('project-board-card--drop-before', 'project-board-card--drop-after')
    }

    if (!card || !status || !anchorPath || !position) {
      if (this.dropIndicatorCard) {
        this.dropIndicatorCard.classList.remove('project-board-card--drop-before', 'project-board-card--drop-after')
      }
      this.dropIndicatorCard = null
      if (!this.currentDropTarget) {
        this.dropHint = null
      }
      return
    }

    this.dropIndicatorCard = card
    card.classList.remove('project-board-card--drop-before', 'project-board-card--drop-after')
    card.classList.add(position === 'before' ? 'project-board-card--drop-before' : 'project-board-card--drop-after')
    this.dropHint = { status, anchorPath, position }
  }

  private handleCardDragOver(
    event: DragEvent,
    status: ProjectBoardStatus,
    card: HTMLElement,
    item: ProjectBoardItem,
  ): void {
    if (!event.dataTransfer) return
    const path = this.dragPath ?? event.dataTransfer.getData('text/plain')
    if (!path) return
    if (path === item.path && item.status === status) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const rect = card.getBoundingClientRect()
    const position: 'before' | 'after' =
      event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    event.dataTransfer.dropEffect = 'move'
    this.setDropTarget(null)
    this.setCardDropIndicator(card, status, item.path, position)
  }

  private handleCardDragLeave(event: DragEvent, card: HTMLElement, item: ProjectBoardItem): void {
    const related = event.relatedTarget as Node | null
    if (related && card.contains(related)) return
    if (this.dropIndicatorCard === card) {
      this.setCardDropIndicator(null)
    }
    if (this.dropHint && this.dropHint.anchorPath === item.path) {
      this.dropHint = null
    }
  }

  private handleCardDrop(
    event: DragEvent,
    status: ProjectBoardStatus,
    item: ProjectBoardItem,
    card: HTMLElement,
  ): void {
    event.preventDefault()
    event.stopPropagation()
    const path = this.dragPath || event.dataTransfer?.getData('text/plain')
    if (!path) return
    const rect = card.getBoundingClientRect()
    const position: 'before' | 'after' =
      event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    this.clearDropState()
    void this.handleStatusChange(path, status, { status, anchorPath: item.path, position })
  }

  private handleDragEnd(event?: DragEvent): void {
    if (event?.currentTarget instanceof HTMLElement) {
      event.currentTarget.classList.remove('project-board-card--dragging')
    } else if (this.dragElement) {
      this.dragElement.classList.remove('project-board-card--dragging')
    }
    this.dragElement = null
    this.clearDropState()
    this.dragPath = null
  }

  private applyLocalStatusUpdate(
    item: ProjectBoardItem,
    status: ProjectBoardStatus,
    order: number,
    options: { markCompleted: boolean; leavingDone: boolean },
  ): void {
    item.status = status
    item.order = order

    if (!item.frontmatter || typeof item.frontmatter !== 'object') {
      item.frontmatter = {}
    }

    item.frontmatter.status = status
    item.frontmatter.order = order

    const updatedIso = new Date().toISOString()
    item.updated = updatedIso
    if (item.frontmatter.updated) {
      delete item.frontmatter.updated
    }
    if (item.frontmatter.created) {
      delete item.frontmatter.created
    }

    if (options.markCompleted && status === 'done') {
      const completed = formatDateStamp()
      item.completed = completed
      item.frontmatter.completed = completed
    } else if (options.leavingDone) {
      item.completed = undefined
      if (item.frontmatter.completed) {
        delete item.frontmatter.completed
      }
    }

    this.optimisticItems.set(item.path, {
      status,
      order,
      updated: updatedIso,
      completed: item.completed,
    })
  }

  private calculateTargetOrder(
    status: ProjectBoardStatus,
    movingPath: string,
    hint?: { status: ProjectBoardStatus; anchorPath: string | null; position: 'before' | 'after' | 'empty' },
  ): number {
    const siblings = this.items
      .filter((entry) => entry.path !== movingPath && entry.status === status)
      .sort((a, b) => this.compareItems(a, b))

    const orderForIndex = (entry: ProjectBoardItem, idx: number): number => {
      if (typeof entry.order === 'number' && Number.isFinite(entry.order)) return entry.order
      return (idx + 1) * 1000
    }

    if (!hint || hint.status !== status) {
      if (siblings.length === 0) return 0
      const last = siblings[siblings.length - 1]
      return orderForIndex(last, siblings.length - 1) + 1000
    }

    if (hint.position === 'empty') {
      if (siblings.length === 0) return 0
      const last = siblings[siblings.length - 1]
      return orderForIndex(last, siblings.length - 1) + 1000
    }

    const anchorIndex = hint.anchorPath
      ? siblings.findIndex((entry) => entry.path === hint.anchorPath)
      : -1

    if (anchorIndex === -1) {
      if (siblings.length === 0) return 0
      const last = siblings[siblings.length - 1]
      return orderForIndex(last, siblings.length - 1) + 1000
    }

    const anchorOrder = orderForIndex(siblings[anchorIndex], anchorIndex)

    if (hint.position === 'before') {
      if (anchorIndex === 0) return anchorOrder - 1000
      const beforeOrder = orderForIndex(siblings[anchorIndex - 1], anchorIndex - 1)
      if (beforeOrder === anchorOrder) return anchorOrder - 1
      return beforeOrder + (anchorOrder - beforeOrder) / 2
    }

    if (anchorIndex === siblings.length - 1) {
      return anchorOrder + 1000
    }
    const afterOrder = orderForIndex(siblings[anchorIndex + 1], anchorIndex + 1)
    if (afterOrder === anchorOrder) return anchorOrder + 1
    return anchorOrder + (afterOrder - anchorOrder) / 2
  }

  private scheduleMetadataRefresh(path: string, status: ProjectBoardStatus): void {
    if (this.metadataSyncWaits.has(path)) return

    const attempts = this.metadataSyncAttempts.get(path) ?? 0
    if (attempts >= MAX_METADATA_SYNC_ATTEMPTS) return
    this.metadataSyncAttempts.set(path, attempts + 1)

    const promise = this.waitForMetadataSync(path, status)
    this.metadataSyncWaits.set(path, promise)

    promise
      .catch(() => {
        // Swallow errors; timeout fallback will handle reconciliation
      })
      .finally(() => {
        if (this.metadataSyncWaits.get(path) === promise) {
          this.metadataSyncWaits.delete(path)
        }
        this.reloadItemsPreservingState()
        this.render()
        if (this.optimisticItems.has(path)) {
          // Metadata still not updated; attempt again with slight delay
          window.setTimeout(() => {
            this.metadataSyncWaits.delete(path)
            this.scheduleMetadataRefresh(path, status)
          }, 150)
        } else {
          this.metadataSyncAttempts.delete(path)
        }
      })
  }

  private async waitForMetadataSync(
    path: string,
    status: ProjectBoardStatus,
    timeout = 2000,
  ): Promise<void> {
    const metadata = this.app.metadataCache

    const isSatisfied = (): boolean => {
      const cache = metadata.getCache(path)
      if (!cache?.frontmatter) return false
      const resolved = normalizeBoardStatus(
        (cache.frontmatter as Record<string, unknown>).status,
      )
      return resolved === status
    }

    if (isSatisfied()) return

    await new Promise<void>((resolve) => {
      let timer: number | null = null
      let ref: EventRef | null = null

      const cleanup = () => {
        if (ref) metadata.offref(ref)
        if (timer) window.clearTimeout(timer)
        resolve()
      }

      const handler = (file: TFile) => {
        if (file.path !== path) return
        if (isSatisfied()) {
          cleanup()
        }
      }

      ref = metadata.on('changed', handler)
      timer = window.setTimeout(() => {
        cleanup()
      }, timeout)
    })
  }

  private async handleStatusChange(
    path: string,
    status: ProjectBoardStatus,
    hint?: { status: ProjectBoardStatus; anchorPath: string | null; position: 'before' | 'after' | 'empty' },
  ): Promise<void> {
    const item = this.items.find((entry) => entry.path === path)
    if (!item) {
      this.dragPath = null
      return
    }

    const targetOrder = this.calculateTargetOrder(status, path, hint)
    const statusChanged = item.status !== status
    const currentOrder = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : null
    const orderChanged =
      typeof targetOrder === 'number'
        ? currentOrder === null || Math.abs(currentOrder - targetOrder) > 1e-6
        : currentOrder !== null
    if (!statusChanged && !orderChanged) {
      this.dragPath = null
      return
    }

    const markCompleted = status === 'done' && statusChanged
    const leavingDone = item.status === 'done' && status !== 'done'

    try {
      await this.boardService.updateProjectStatus(path, status, {
        order: targetOrder,
        markCompleted: leavingDone ? false : markCompleted,
      })
      this.applyLocalStatusUpdate(item, status, targetOrder, {
        markCompleted,
        leavingDone,
      })
      this.render()
      this.reloadItemsPreservingState()
      this.scheduleMetadataRefresh(path, status)
    } catch (error) {
      console.error('[ProjectBoard] Failed to move project', error)
      new Notice(this.translate('projectBoard.errors.moveFailed', 'Failed to move project'))
    } finally {
      this.dragPath = null
    }
  }
}

export default ProjectBoardView
