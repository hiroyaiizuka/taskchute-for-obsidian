import { Notice, type App } from 'obsidian'
import type { ScopedTranslator } from '@/i18n'
import type { DayComment, TaskInstance } from '@/types'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import { CommentModal } from './ui/CommentModal'
import { DayCommentsButton, createDayCommentsWindow } from './ui/DayCommentsWindow'
import {
  NOW_ATTR,
  createCommentItem,
  createCommentTextarea,
  findFocusTarget,
  formatCommentTime,
} from './ui/commentDom'
import { showUndoNotice } from './ui/undoNotice'

/** The day's input (its drafts are kept per date); any other key is an instance id. */
const DAY = 'day'
/** A task's panel shows this many, then a button for the rest. */
const TASK_PREVIEW = 3
const NOW_TICK_MS = 10_000

export interface CommentStore {
  getComments(options: { instanceId?: string; dateKey?: string }): DayComment[]
  addCommentTo(dateKey: string, input: { text: string; instanceId?: string }): Promise<DayComment | null>
  deleteComment(id: string, dateKey?: string): DayComment | null
  restoreComment(id: string, dateKey?: string): DayComment | null
}

export interface CommentsControllerHost {
  app: App
  tv: ScopedTranslator<'taskChuteView'>
  store: CommentStore
  /** The day the view shows; comments are kept on it. */
  getDateKey: () => string
  isViewingToday: () => boolean
  /** The view's root, for focus and the clocks of open inputs; a phone's drawer covers it. */
  getRoot: () => HTMLElement | null
  /** The day the view shows, as its header writes it ("10/16 Fri"). */
  getDayLabel: () => string
  /** Rebuilds the task list (and with it the day box and the panels). */
  rerender: () => void
  getInstanceTitle: (instanceId: string) => string
  /** Running human task for the "leave a comment" command, if any. */
  getCommandTargetInstanceId: () => string | null
  /**
   * Whether the view is narrow (a phone, or a narrow pane): adding and
   * rewriting then happen in a modal instead of in place.
   */
  isNarrow: () => boolean
  /** A phone: the day's comments open as a drawer over the whole view. */
  isPhone: () => boolean
  /** The setting for the day's button; off by default. Running tasks take comments either way. */
  isDayCommentsEnabled: () => boolean
  registerInterval: (id: number) => void
  registerCleanup: (cleanup: () => void) => void
}

/** Comments are kept for running human tasks; an AI task's run has its own log. */
export function canCommentWhileRunning(inst: TaskInstance): boolean {
  return inst.state === 'running' && Boolean(inst.instanceId) && inst.task?.frontmatter?.['ai_task'] !== true
}

/**
 * Comments written while working (#181, proposal E): the day's comments
 * behind a button at the bottom right of the task list (LEV-346), opening a
 * window there (a drawer on a phone) listed oldest first like a chat, and a
 * running task's comments in a panel under its row, opened by the row's 💬,
 * newest first. Only one input or editor is open at a time.
 */
export class CommentsController {
  private readonly drafts = new Map<string, string>()
  /** Inputs opened by focus, by key. */
  private readonly composing = new Set<string>()
  private openInstanceId: string | null = null
  private readonly showAll = new Set<string>()
  /** A confirm modal is up; focus moving into it must not close anything. */
  private confirming = false
  /** Bumped to cancel a refocus still waiting for the next frame. */
  private focusToken = 0
  private dayArea: HTMLElement | null = null
  private dayButton: DayCommentsButton | null = null
  private dayWindow: HTMLElement | null = null
  private dayOpen = false
  /** The next draw of the day's window scrolls to its newest comment. */
  private dayToEnd = false

  constructor(private readonly host: CommentsControllerHost) {}

  /** Puts the day's button (and, while open, its window) over `area`, the task list's frame. */
  mountDay(area: HTMLElement): void {
    this.dayArea = area
    this.dayButton = new DayCommentsButton(area, () => (this.dayOpen ? this.closeDay() : this.openDay()))
    this.host.registerInterval(window.setInterval(() => this.tickClocks(), NOW_TICK_MS))
    this.watchWidth()
    this.renderDay()
  }

  /**
   * Crossing the narrow width swaps in-place inputs for modals (and back):
   * close what is open and draw again. Drafts are kept.
   */
  private watchWidth(): void {
    const root = this.host.getRoot()
    if (!root || typeof ResizeObserver === 'undefined') return
    let narrow = this.host.isNarrow()
    const observer = new ResizeObserver(() => {
      const next = this.host.isNarrow()
      if (next === narrow) return
      narrow = next
      this.composing.clear()
      this.host.rerender()
    })
    observer.observe(root)
    this.host.registerCleanup(() => observer.disconnect())
  }

  // --- the day's button and window -----------------------------------------------

  renderDay(): void {
    const area = this.dayArea
    const button = this.dayButton
    if (!area || !button) return
    const enabled = this.host.isDayCommentsEnabled()
    // Turned off in settings: no button, and the window closes. Drafts stay for when it is back on.
    if (!enabled) this.dayOpen = false
    const comments = enabled ? this.host.store.getComments({ dateKey: this.host.getDateKey() }) : []
    const phone = this.host.isPhone()
    // A phone's drawer covers the button, so it never turns into a close button there.
    const showClose = this.dayOpen && !phone
    area.classList.toggle('has-day-comments-button', enabled)
    this.host.getRoot()?.classList.toggle('has-day-comments-drawer', this.dayOpen && phone)
    button.update({
      visible: enabled,
      count: comments.length,
      open: showClose,
      label: showClose ? this.host.tv('comments.closeDay', 'Close the comments') : this.dayTitle(),
    })

    const previousScroll = this.dayWindow?.querySelector('.taskchute-day-comments-window__body')?.scrollTop ?? 0
    this.dayWindow?.remove()
    this.dayWindow = null
    if (!this.dayOpen) return

    const parts = createDayCommentsWindow(phone ? this.host.getRoot() ?? area : area, {
      drawer: phone,
      title: this.dayTitle(),
      count: comments.length > 0 ? this.host.tv('comments.count', '{count} comments', { count: comments.length }) : '',
      label: this.host.tv('comments.regionLabel', 'Comments for the day'),
      closeLabel: this.host.tv('comments.closeDay', 'Close the comments'),
      onClose: () => this.closeDay(),
    })
    this.dayWindow = parts.el
    if (comments.length === 0) {
      parts.body.createEl('p', {
        cls: 'taskchute-comment-empty',
        text: this.host.tv('comments.dayEmpty', 'No comments for this day yet'),
      })
    } else {
      // Oldest first, like a chat: the newest sits just above the input.
      parts.body.appendChild(this.list([...comments].reverse()))
    }
    // Comments are written only for today; a past or future day is for reading back (LEV-346).
    if (this.host.isViewingToday()) {
      parts.composer.appendChild(this.dayComposer(phone))
    } else {
      parts.composer.createEl('p', {
        cls: 'taskchute-day-comments-window__only-today',
        text: this.host.tv('comments.onlyToday', 'Comments can be added only for today.'),
      })
    }
    parts.body.scrollTop = this.dayToEnd ? parts.body.scrollHeight : previousScroll
    this.dayToEnd = false
  }

  private dayTitle(): string {
    return this.host.isViewingToday()
      ? this.host.tv('comments.dayTitle', "Today's comments")
      : this.host.tv('comments.otherDayTitle', 'Comments for {date}', { date: this.host.getDayLabel() })
  }

  private dayDraftKey(): string {
    return `${DAY}:${this.host.getDateKey()}`
  }

  /** The window's input: always open, Enter adds (a phone has no Shift, so there the button adds). */
  private dayComposer(phone: boolean): HTMLElement {
    const draftKey = this.dayDraftKey()
    const wrapper = createDiv({ cls: 'taskchute-day-comments-window__input' })
    const box = wrapper.createDiv({ cls: 'taskchute-comment-composer' })
    const textarea = createCommentTextarea(box, {
      cls: 'taskchute-comment-input',
      focusKey: this.composeKey(DAY),
      value: this.drafts.get(draftKey) ?? '',
      placeholder: this.host.tv('comments.dayPlaceholder', 'Add a comment for today…'),
      submitOnEnter: !phone,
      onInput: (value) => this.drafts.set(draftKey, value),
      onSubmit: (text) => void this.submitDay(text),
      onEscape: () => this.closeDay(),
    })
    const add = box.createEl('button', { cls: 'mod-cta taskchute-comment-composer__add', text: this.host.tv('comments.add', 'Add') })
    add.addEventListener('click', () => void this.submitDay(textarea.value))
    if (!phone) {
      wrapper.createDiv({ cls: 'taskchute-comment-hint', text: this.host.tv('comments.dayHint', 'Enter to add · Shift+Enter for a new line · Esc to close') })
    }
    return wrapper
  }

  private openDay(): void {
    this.dayOpen = true
    this.dayToEnd = true
    // A phone's keyboard would cover half the drawer; it comes up on a tap in the input.
    if (this.host.isPhone()) {
      this.host.rerender()
      return
    }
    this.focusAfterRender(this.composeKey(DAY))
  }

  private closeDay(): void {
    if (!this.dayOpen) return
    this.dayOpen = false
    this.focusToken += 1
    this.host.rerender()
    this.dayButton?.el.focus()
  }

  private async submitDay(text: string): Promise<void> {
    if (!text.trim()) return
    const draftKey = this.dayDraftKey()
    // Clear the draft first: adding re-renders.
    const previous = this.drafts.get(draftKey)
    this.drafts.delete(draftKey)
    const added = await this.host.store.addCommentTo(this.host.getDateKey(), { text })
    if (!added) {
      if (previous !== undefined) this.drafts.set(draftKey, previous)
      return
    }
    this.dayToEnd = true
    this.focusAfterRender(this.composeKey(DAY))
  }

  // --- a running task's panel -------------------------------------------------

  /** What the row's 💬 shows for a running task, or null to keep the usual button. */
  commentButton(inst: TaskInstance): { count: number; open: boolean } | null {
    if (!canCommentWhileRunning(inst)) return null
    const count = this.host.store.getComments({ instanceId: inst.instanceId, dateKey: this.host.getDateKey() }).length
    return { count, open: this.openInstanceId === inst.instanceId }
  }

  togglePanel(inst: TaskInstance): void {
    if (!canCommentWhileRunning(inst)) return
    if (this.openInstanceId === inst.instanceId) {
      this.openInstanceId = null
      this.host.rerender()
      return
    }
    this.openInstanceId = inst.instanceId
    if (this.host.isNarrow()) {
      this.host.rerender()
      return
    }
    this.openComposer(inst.instanceId)
  }

  /** The panel under a running row, when it is open. */
  renderPanel(inst: TaskInstance): HTMLElement | null {
    if (!canCommentWhileRunning(inst) || this.openInstanceId !== inst.instanceId) return null
    const key = inst.instanceId
    const panel = createDiv({ cls: 'taskchute-task-comments' })
    panel.appendChild(this.composer(key, this.host.tv('comments.taskPlaceholder', 'Add a comment while working…')))
    const comments = this.host.store.getComments({ instanceId: key, dateKey: this.host.getDateKey() })
    if (comments.length === 0) {
      panel.createEl('p', { cls: 'taskchute-comment-empty', text: this.host.tv('comments.empty', 'No comments yet') })
    } else {
      panel.appendChild(this.list(comments, { key, limit: TASK_PREVIEW }))
    }
    return panel
  }

  /** A finished task's comments from while it ran, for the completion modal (read-only). */
  commentsFor(instanceId: string, dateKey?: string): DayComment[] {
    return this.host.store.getComments({ instanceId, dateKey: dateKey ?? this.host.getDateKey() })
  }

  /** The "leave a comment" command: the running task's input, or else the day's window. */
  leaveComment(): void {
    const instanceId = this.host.getCommandTargetInstanceId()
    if (instanceId) {
      this.openInstanceId = instanceId
      if (this.host.isNarrow()) {
        this.host.rerender()
        this.openAddModal(instanceId)
        return
      }
      this.openComposer(instanceId)
      return
    }
    if (!this.host.isDayCommentsEnabled()) {
      new Notice(
        this.host.tv(
          'comments.noTarget',
          'Start a task to comment on it, or turn on comments for the day in settings.',
        ),
      )
      return
    }
    this.openDay()
  }

  // --- the input ---------------------------------------------------------------

  private openComposer(key: string): void {
    this.openOnly(() => {
      this.composing.add(key)
      this.focusAfterRender(this.composeKey(key))
    }, key)
  }

  private composeKey(key: string): string {
    return `compose:${key}`
  }

  /**
   * The input and its add button, opening like X's composer: one line until it
   * is focused, then a taller box with the time, a hint and the button. It
   * closes again when left empty; leaving it with unsaved text asks first.
   */
  private composer(key: string, placeholder: string): HTMLElement {
    if (this.host.isNarrow()) return this.tapComposer(key, placeholder)
    const open = this.composing.has(key) || Boolean(this.drafts.get(key))
    const box = createDiv({ cls: `taskchute-comment-composer${open ? ' is-open' : ''}` })
    const submit = (text: string) => void this.submit(key, text)
    const addButton = createEl('button', { cls: 'mod-cta taskchute-comment-composer__add', text: this.host.tv('comments.add', 'Add') })
    addButton.addEventListener('click', () => submit(textarea.value))
    let textarea: HTMLTextAreaElement
    if (open) {
      const body = box.createDiv({ cls: 'taskchute-comment-composer__body' })
      body.createEl('time', { cls: 'taskchute-comment-composer__now', text: formatCommentTime(Date.now()), attr: { [NOW_ATTR]: '' } })
      textarea = this.textarea(body, key, placeholder, submit)
      const foot = box.createDiv({ cls: 'taskchute-comment-composer__foot' })
      foot.createSpan({ cls: 'taskchute-comment-hint', text: this.host.tv('comments.addHint', 'Enter to add') })
      foot.appendChild(addButton)
    } else {
      textarea = this.textarea(box, key, placeholder, submit)
      box.appendChild(addButton)
    }
    textarea.addEventListener('focus', () => {
      if (this.composing.has(key) || this.confirming) return
      this.openComposer(key)
    })
    box.addEventListener('focusout', () => {
      // Wait for the next focus: a click on the add button must land first.
      window.setTimeout(() => this.afterComposerBlur(key), 150)
    })
    return box
  }

  private textarea(parent: HTMLElement, key: string, placeholder: string, submit: (text: string) => void): HTMLTextAreaElement {
    const textarea = createCommentTextarea(parent, {
      cls: 'taskchute-comment-input',
      focusKey: this.composeKey(key),
      value: this.drafts.get(key) ?? '',
      placeholder,
      onInput: (value) => this.drafts.set(key, value),
      onSubmit: submit,
      // Esc leaves the input the way clicking elsewhere does: an empty input
      // closes, unsaved text asks first.
      onEscape: () => {
        this.focusToken += 1
        textarea.blur()
      },
    })
    return textarea
  }

  private afterComposerBlur(key: string): void {
    if (this.confirming) return
    const root = this.host.getRoot()
    const current = root ? findFocusTarget(root, this.composeKey(key)) : null
    const box = current?.closest('.taskchute-comment-composer')
    if (box && box.contains(box.ownerDocument.activeElement)) return
    if (this.drafts.get(key)?.trim()) {
      void this.confirmLeave(key)
      return
    }
    if (this.composing.delete(key)) this.host.rerender()
  }

  private async submit(key: string, text: string): Promise<void> {
    if (!text.trim()) return
    // Clear the draft first: adding re-renders.
    const previous = this.drafts.get(key)
    this.drafts.delete(key)
    const added = await this.host.store.addCommentTo(this.host.getDateKey(), { text, instanceId: key })
    if (!added) {
      if (previous !== undefined) this.drafts.set(key, previous)
      return
    }
    this.focusAfterRender(this.composeKey(key))
  }

  /** Leaving an input with unsaved text: delete it, or go back to writing. */
  private async confirmLeave(key: string): Promise<void> {
    this.confirming = true
    const discard = await showConfirmModal(this.host.app, {
      title: this.host.tv('comments.leaveTitle', 'Delete this comment?'),
      message: this.host.tv('comments.leaveMessage', 'This comment has not been saved.'),
      confirmText: this.host.tv('comments.delete', 'Delete'),
      cancelText: this.host.tv('comments.cancel', 'Cancel'),
      destructive: true,
    })
    this.confirming = false
    if (discard) {
      this.drafts.delete(key)
      this.composing.delete(key)
      this.host.rerender()
    } else {
      this.focusAfterRender(this.composeKey(key))
    }
  }

  /**
   * Only one input is open at a time. Before `open` runs the others close;
   * when one of them holds unsaved text, ask first. Cancel goes back to that
   * one. `except` is the input being opened.
   */
  private openOnly(open: () => void, except?: string): void {
    const dirtyInputs = Array.from(this.composing).filter((k) => k !== except && this.drafts.get(k)?.trim())
    const closeOthers = () => {
      for (const k of Array.from(this.composing)) {
        if (k === except) continue
        this.composing.delete(k)
        this.drafts.delete(k)
      }
    }
    if (dirtyInputs.length === 0) {
      closeOthers()
      open()
      return
    }
    this.confirming = true
    void showConfirmModal(this.host.app, {
      title: this.host.tv('comments.discardTitle', 'Discard the unsaved comment?'),
      message: this.host.tv('comments.discardMessage', 'Another open comment has unsaved changes.'),
      confirmText: this.host.tv('comments.discard', 'Discard'),
      cancelText: this.host.tv('comments.cancel', 'Cancel'),
      destructive: true,
    }).then((discard) => {
      this.confirming = false
      if (discard) {
        closeOthers()
        open()
        return
      }
      if (except) this.composing.delete(except)
      this.focusAfterRender(this.composeKey(dirtyInputs[0]))
    })
  }

  // --- phones: a tap target and a modal ----------------------------------------

  private tapComposer(key: string, placeholder: string): HTMLElement {
    const draft = this.drafts.get(key)
    const box = createDiv({ cls: 'taskchute-comment-composer is-tap' })
    const field = box.createEl('button', {
      cls: `taskchute-comment-input taskchute-comment-tap${draft ? ' has-draft' : ''}`,
      text: draft || placeholder,
    })
    field.addEventListener('click', () => this.openAddModal(key))
    const add = box.createEl('button', { cls: 'mod-cta taskchute-comment-composer__add', text: this.host.tv('comments.add', 'Add') })
    add.addEventListener('click', () => this.openAddModal(key))
    return box
  }

  /** Adding to a running task on a narrow view. */
  private openAddModal(key: string): void {
    new CommentModal(this.host.app, {
      title: this.host.tv('comments.addTaskTitle', 'Add a comment to "{title}"', { title: this.host.getInstanceTitle(key) }),
      at: Date.now(),
      value: this.drafts.get(key) ?? '',
      submitText: this.host.tv('comments.add', 'Add'),
      cancelText: this.host.tv('comments.cancel', 'Cancel'),
      onDraft: (text) => this.drafts.set(key, text),
      onSubmit: (text) => {
        if (!text.trim()) return false
        void this.submit(key, text).then(() => this.host.rerender())
        return true
      },
    }).open()
  }

  // --- the list and deleting -----------------------------------------------------

  /**
   * Time and text, in the order given, each with a button that deletes it:
   * comments are not rewritten (typos and loose wording are fine, LEV-346).
   * `limit` shows that many, then a toggle for the rest.
   */
  private list(comments: DayComment[], options: { key?: string; limit?: number } = {}): HTMLElement {
    const wrapper = createDiv({ cls: 'taskchute-comment-entries' })
    const all = !options.limit || (options.key !== undefined && this.showAll.has(options.key))
    const shown = all ? comments : comments.slice(0, options.limit)
    const ul = wrapper.createEl('ul', { cls: 'taskchute-comment-list' })
    for (const comment of shown) {
      createCommentItem(ul, comment, {
        deleteLabel: this.host.tv('comments.deleteLabel', 'Delete this comment'),
        onDelete: () => this.deleteWithUndo(comment.id),
      })
    }
    const hidden = comments.length - shown.length
    if (options.limit && options.key !== undefined && (hidden > 0 || all) && comments.length > options.limit) {
      const key = options.key
      const toggle = wrapper.createEl('button', {
        cls: 'taskchute-comment-toggle',
        text: all
          ? this.host.tv('comments.showLess', 'Show less')
          : this.host.tv('comments.showMore', 'Show more ({count})', { count: hidden }),
      })
      toggle.addEventListener('click', () => {
        if (all) this.showAll.delete(key)
        else this.showAll.add(key)
        this.host.rerender()
      })
    }
    return wrapper
  }

  /**
   * The completion modal's list of a task's comments while it ran (LEV-347):
   * deleting there works like anywhere else, and `redraw` redraws that list
   * (on delete and on undo).
   */
  deleteRunningComment(id: string, redraw: () => void): void {
    this.deleteWithUndo(id, redraw)
  }

  /** Deletes at once and offers undo in a notice instead of asking first. */
  private deleteWithUndo(id: string, redraw?: () => void): void {
    const dateKey = this.host.getDateKey()
    const removed = this.host.store.deleteComment(id, dateKey)
    this.host.rerender()
    redraw?.()
    if (!removed) return
    showUndoNotice(
      this.host.tv('comments.deleted', 'Comment deleted'),
      this.host.tv('comments.undo', 'Undo'),
      () => {
        this.host.store.restoreComment(id, dateKey)
        this.host.rerender()
        redraw?.()
      },
    )
  }

  // --- focus and clocks ----------------------------------------------------------

  private focusAfterRender(focusKey: string, caret: 'end' | 'keep' = 'end'): void {
    this.host.rerender()
    const token = ++this.focusToken
    window.requestAnimationFrame(() => {
      // Leaving the input (Esc) in the meantime cancels the refocus.
      if (token !== this.focusToken) return
      const root = this.host.getRoot()
      const target = root ? findFocusTarget(root, focusKey) : null
      if (!target) return
      target.focus()
      if (caret === 'end') target.setSelectionRange(target.value.length, target.value.length)
    })
  }

  private tickClocks(): void {
    const root = this.host.getRoot()
    if (!root) return
    const now = formatCommentTime(Date.now())
    root.querySelectorAll(`[${NOW_ATTR}]`).forEach((node) => {
      node.textContent = now
    })
  }
}

