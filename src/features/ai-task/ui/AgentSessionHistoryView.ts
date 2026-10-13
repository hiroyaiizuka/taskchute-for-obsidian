/**
 * AI Task - the AI pane's "Session history" sidebar
 *
 * Lists the past agent sessions of the vault's folder, newest first: a search
 * box, a reload button and an archive switch on top, then one row per session
 * (title, last message, agent and time) with Resume and Archive (or Restore)
 * actions. Pages load as the list scrolls to its end.
 */

import { setIcon } from 'obsidian'
import { getCurrentLocale, type ScopedTranslator } from '@/i18n'
import { getAiAgent } from '../agents'
import type { AgentSessionListItem, AgentSessionPage, AgentSessionPageRequest } from '../sessions/AgentSessionHistory'

export interface AgentSessionHistoryViewDeps {
  tv: ScopedTranslator<'taskChuteView'>
  /** The history and the folder it lists; undefined where it is unavailable. */
  source(): { refresh(): Promise<void>; page(request: AgentSessionPageRequest): Promise<AgentSessionPage>; folder: string } | undefined
  archive(item: AgentSessionListItem): void
  restore(item: AgentSessionListItem): void
  resume(item: AgentSessionListItem): void
  /** Whether sessions can be resumed here (they open in a terminal). */
  canResume(): boolean
}

const SEARCH_DEBOUNCE_MS = 250
const LOAD_MORE_THRESHOLD_PX = 120

export class AgentSessionHistoryView {
  private readonly listEl: HTMLElement
  private readonly searchInput: HTMLInputElement
  private readonly archiveToggle: HTMLButtonElement
  private showArchived = false
  private nextCursor: number | null = null
  private loading = false
  /** Bumps on every new listing so a slow page of an old query is dropped. */
  private generation = 0
  private searchTimer: number | null = null

  constructor(
    private readonly container: HTMLElement,
    private readonly deps: AgentSessionHistoryViewDeps,
  ) {
    const { tv } = deps
    const toolbar = container.createDiv({ cls: 'ai-session-history__toolbar' })
    this.searchInput = toolbar.createEl('input', {
      cls: 'ai-session-history__search',
      attr: { type: 'search', placeholder: tv('aiTask.history.search', 'Search sessions'), 'aria-label': tv('aiTask.history.search', 'Search sessions') },
    })
    this.searchInput.addEventListener('input', () => {
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null
        void this.reload()
      }, SEARCH_DEBOUNCE_MS)
    })
    const refreshLabel = tv('aiTask.history.refresh', 'Reload')
    const refresh = toolbar.createEl('button', {
      cls: 'clickable-icon ai-session-history__refresh',
      attr: { 'aria-label': refreshLabel, title: refreshLabel },
    })
    setIcon(refresh, 'refresh-cw')
    refresh.addEventListener('click', () => void this.refresh())
    const archivedLabel = tv('aiTask.history.showArchived', 'Show archived')
    this.archiveToggle = toolbar.createEl('button', {
      cls: 'clickable-icon ai-session-history__archived',
      attr: { 'aria-label': archivedLabel, title: archivedLabel, 'aria-pressed': 'false' },
    })
    setIcon(this.archiveToggle, 'archive')
    this.archiveToggle.addEventListener('click', () => {
      this.showArchived = !this.showArchived
      this.archiveToggle.setAttribute('aria-pressed', this.showArchived ? 'true' : 'false')
      void this.reload()
    })
    this.listEl = container.createDiv({ cls: 'ai-session-history__list', attr: { role: 'list' } })
    this.listEl.addEventListener('scroll', () => {
      const { scrollTop, clientHeight, scrollHeight } = this.listEl
      if (scrollTop + clientHeight >= scrollHeight - LOAD_MORE_THRESHOLD_PX) void this.loadMore()
    })
  }

  /** Lists the session files again, then shows the first page. */
  async refresh(): Promise<void> {
    const source = this.deps.source()
    if (!source) {
      this.showMessage(this.deps.tv('aiTask.history.unavailable', 'Session history is unavailable here.'))
      return
    }
    this.showMessage(this.deps.tv('aiTask.history.loading', 'Loading sessions…'))
    await source.refresh()
    await this.reload()
  }

  destroy(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    this.generation += 1
  }

  private async reload(): Promise<void> {
    this.generation += 1
    this.nextCursor = 0
    this.listEl.empty()
    this.listEl.scrollTop = 0
    await this.loadMore(true)
  }

  private async loadMore(first = false): Promise<void> {
    const source = this.deps.source()
    if (!source || this.loading || this.nextCursor === null) return
    const generation = this.generation
    this.loading = true
    try {
      const page = await source.page({
        folder: source.folder,
        query: this.searchInput.value,
        archived: this.showArchived,
        cursor: this.nextCursor,
      })
      if (generation !== this.generation) return
      this.nextCursor = page.nextCursor
      for (const item of page.items) this.renderRow(item)
      if (first && page.items.length === 0) {
        this.showMessage(
          this.showArchived
            ? this.deps.tv('aiTask.history.emptyArchived', 'No archived sessions.')
            : this.searchInput.value.trim()
              ? this.deps.tv('aiTask.history.noMatch', 'No sessions match.')
              : this.deps.tv('aiTask.history.empty', 'No sessions have run in this vault yet.'),
        )
      }
    } finally {
      this.loading = false
    }
  }

  private showMessage(text: string): void {
    this.listEl.empty()
    this.listEl.createDiv({ cls: 'ai-session-history__message', text })
  }

  private renderRow(item: AgentSessionListItem): void {
    const { tv } = this.deps
    const agent = getAiAgent(item.host)
    const row = this.listEl.createDiv({ cls: 'ai-session-history__row', attr: { role: 'listitem' } })
    row.dataset.sessionHost = item.host
    row.dataset.sessionId = item.id
    const head = row.createDiv({ cls: 'ai-session-history__head' })
    head.createSpan({ cls: 'ai-session-history__title', text: item.title, attr: { title: item.title } })
    const actions = head.createDiv({ cls: 'ai-session-history__actions' })

    const canResume = this.deps.canResume()
    const resumeLabel = canResume
      ? tv('aiTask.history.resume', 'Resume')
      : tv('aiTask.history.resumeUnavailable', 'Resume needs a terminal, which is not available here')
    const resume = actions.createEl('button', {
      cls: 'clickable-icon ai-session-history__resume',
      attr: { 'aria-label': resumeLabel, title: resumeLabel },
    })
    setIcon(resume, 'play')
    resume.disabled = !canResume
    resume.addEventListener('click', () => this.deps.resume(item))

    const archiveLabel = item.archived
      ? tv('aiTask.history.restore', 'Restore to the list')
      : tv('aiTask.history.archive', 'Archive')
    const archive = actions.createEl('button', {
      cls: 'clickable-icon ai-session-history__archive',
      attr: { 'aria-label': archiveLabel, title: archiveLabel },
    })
    setIcon(archive, item.archived ? 'archive-restore' : 'archive')
    archive.addEventListener('click', () => {
      if (item.archived) this.deps.restore(item)
      else this.deps.archive(item)
      row.remove()
    })

    const snippet = item.lastText ?? item.firstText
    if (snippet) row.createDiv({ cls: 'ai-session-history__snippet', text: snippet })
    const meta = row.createDiv({ cls: 'ai-session-history__meta' })
    meta.createSpan({ cls: 'ai-session-history__agent', text: `${agent.icon} ${tv(agent.label.key, agent.label.fallback)}` })
    meta.createSpan({ cls: 'ai-session-history__time', text: relativeTime(item.updatedAt) })
  }
}

/** "3 hours ago" in the UI's language. */
function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
  ]
  const format = new Intl.RelativeTimeFormat(getCurrentLocale(), { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'minute')
}
