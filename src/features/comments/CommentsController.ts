import { Notice, type App } from 'obsidian'
import type { ScopedTranslator } from '@/i18n'
import type { DayComment, TaskInstance } from '@/types'
import { formatDate } from '@/utils/date'
import { CommentModal } from './ui/CommentModal'
import { DayCommentsButton, createCommentsWindow, pointAtCommentButton } from './ui/DayCommentsWindow'
import { RunningTaskSuggestModal } from './ui/RunningTaskSuggestModal'
import { createCommentEditor, createCommentItem, createCommentTextarea, findFocusTarget } from './ui/commentDom'
import { showUndoNotice } from './ui/undoNotice'

/** The day's input (its drafts are kept per date); any other key is an instance id. */
const DAY = 'day'
/** A task's panel on a narrow view shows this many, then a button for the rest. */
const TASK_PREVIEW = 3

export interface CommentStore {
  getComments(options: { instanceId?: string; dateKey?: string }): DayComment[]
  addCommentTo(dateKey: string, input: { text: string; instanceId?: string }): Promise<DayComment | null>
  /** Rewrites a comment's text; blank text deletes it. */
  updateComment(id: string, text: string, dateKey?: string): DayComment | null
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
  /** The view's root, for focus; a phone's drawer covers it. */
  getRoot: () => HTMLElement | null
  /** The day the view shows, as its header writes it ("10/16 Fri"). */
  getDayLabel: () => string
  /** Rebuilds the task list (and with it the day's window and a task's popover or panel). */
  rerender: () => void
  getInstanceTitle: (instanceId: string) => string
  /** Running human task for the "leave a comment" command, if any. */
  getCommandTargetInstanceId: () => string | null
  /** Every running human task, the one started last first (LEV-415). */
  getRunningInstanceIds: () => string[]
  /**
   * Whether the view is narrow (a phone, or a narrow pane): a running task's
   * comments then open in a panel under its row, and are added in a modal.
   */
  isNarrow: () => boolean
  /** A phone: the day's comments open as a drawer over the whole view. */
  isPhone: () => boolean
  /** The setting for the day's button; off by default. Running tasks take comments either way. */
  isDayCommentsEnabled: () => boolean
  /** The setting that lists a task's comments from while it ran under its row (LEV-412); off by default. */
  isRowCommentsEnabled: () => boolean
  registerCleanup: (cleanup: () => void) => void
}

/** Comments are kept for running human tasks; an AI task's run has its own log. */
export function canCommentWhileRunning(inst: TaskInstance): boolean {
  return inst.state === 'running' && Boolean(inst.instanceId) && inst.task?.frontmatter?.['ai_task'] !== true
}

/**
 * Comments written while working (#181, proposal E): the day's comments
 * behind a button at the bottom right of the task list (LEV-346), opening a
 * window there (a drawer on a phone), and a running task's comments in a
 * popover under its row's 💬, laid out like that window: oldest first like
 * a chat, piling up toward the input fixed at the bottom. On a narrow view a
 * task's comments open in a panel under its row instead, newest first, and
 * are added in a modal. Unsent text is kept per input until it is sent.
 */
export class CommentsController {
  private readonly drafts = new Map<string, string>()
  /** Inputs whose comment is being saved: a second Enter before the redraw must not add it twice. */
  private readonly sending = new Set<string>()
  private openInstanceId: string | null = null
  private readonly showAll = new Set<string>()
  /** Bumped to cancel a refocus still waiting for the next frame. */
  private focusToken = 0
  /** The popover's list scroll, kept across the re-renders that rebuild it. */
  private panelScroll = 0
  /** The next draw of the popover scrolls to its newest comment. */
  private panelToEnd = false
  /** The next draw of the popover is its opening one, which animates. */
  private panelEnter = false
  private dayArea: HTMLElement | null = null
  private dayButton: DayCommentsButton | null = null
  private dayWindow: HTMLElement | null = null
  private dayOpen = false
  /** The next draw of the day's window scrolls to its newest comment. */
  private dayToEnd = false
  /** The comment being rewritten in place, wherever its list is drawn (LEV-413). */
  private editingId: string | null = null

  constructor(private readonly host: CommentsControllerHost) {}

  /** Puts the day's button (and, while open, its window) over `area`, the task list's frame. */
  mountDay(area: HTMLElement): void {
    this.dayArea = area
    this.dayButton = new DayCommentsButton(area, () => (this.dayOpen ? this.closeDay() : this.openDay()))
    this.watchWidth()
    this.renderDay()
  }

  /**
   * Crossing the narrow width swaps a task's popover for the panel and modal
   * (and back): draw again. Drafts are kept.
   */
  private watchWidth(): void {
    const root = this.host.getRoot()
    if (!root || typeof ResizeObserver === 'undefined') return
    let narrow = this.host.isNarrow()
    const observer = new ResizeObserver(() => {
      const next = this.host.isNarrow()
      if (next === narrow) return
      narrow = next
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
    const phone = this.host.isPhone()
    // A phone's drawer covers the button, so it never turns into a close button there.
    const showClose = this.dayOpen && !phone
    area.classList.toggle('has-day-comments-button', enabled)
    this.host.getRoot()?.classList.toggle('has-day-comments-drawer', this.dayOpen && phone)
    button.update({
      visible: enabled,
      open: showClose,
      label: showClose ? this.host.tv('comments.closeDay', 'Close the comments') : this.dayTitle(),
    })

    const previousScroll = this.dayWindow?.querySelector('.taskchute-day-comments-window__body')?.scrollTop ?? 0
    this.dayWindow?.remove()
    this.dayWindow = null
    if (!this.dayOpen) return

    // Only an open window needs them: the button no longer carries a count.
    const comments = this.host.store.getComments({ dateKey: this.host.getDateKey() })
    const parts = createCommentsWindow(phone ? this.host.getRoot() ?? area : area, {
      kind: phone ? 'drawer' : 'window',
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

  private dayComposer(phone: boolean): HTMLElement {
    return this.windowInput({
      draftKey: this.dayDraftKey(),
      focusKey: this.composeKey(DAY),
      placeholder: this.host.tv('comments.dayPlaceholder', 'Add a comment for today…'),
      submitOnEnter: !phone,
      onSubmit: (text) => void this.submitDay(text),
      onEscape: () => this.closeDay(),
    })
  }

  /**
   * A comments window's input, under its list: always open. Enter adds,
   * Shift+Enter is a new line, Esc closes the window (a phone has no Shift,
   * so there Enter is a new line and the button adds).
   */
  private windowInput(options: {
    draftKey: string
    focusKey: string
    placeholder: string
    submitOnEnter: boolean
    onSubmit: (text: string) => void
    onEscape: () => void
  }): HTMLElement {
    const wrapper = createDiv({ cls: 'taskchute-day-comments-window__input' })
    const box = wrapper.createDiv({ cls: 'taskchute-comment-composer' })
    const textarea = createCommentTextarea(box, {
      cls: 'taskchute-comment-input',
      focusKey: options.focusKey,
      value: this.drafts.get(options.draftKey) ?? '',
      placeholder: options.placeholder,
      submitOnEnter: options.submitOnEnter,
      onInput: (value) => this.drafts.set(options.draftKey, value),
      onSubmit: options.onSubmit,
      onEscape: options.onEscape,
    })
    const add = box.createEl('button', { cls: 'mod-cta taskchute-comment-composer__add', text: this.host.tv('comments.add', 'Add') })
    add.addEventListener('click', () => options.onSubmit(textarea.value))
    // No key hint under the input: it showed every time the window opened,
    // which is noise for something written many times a day (LEV-367).
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
    const draftKey = this.dayDraftKey()
    if (!text.trim() || this.sending.has(draftKey)) return
    // Clear the draft first: adding re-renders.
    const previous = this.drafts.get(draftKey)
    this.drafts.delete(draftKey)
    // Kept on the day it is sent, not the day on screen: written past midnight,
    // that is the new day (LEV-346).
    const sentOn = new Date()
    const dateKey = formatDate(sentOn)
    this.sending.add(draftKey)
    let added: DayComment | null
    try {
      added = await this.host.store.addCommentTo(dateKey, { text })
    } finally {
      this.sending.delete(draftKey)
    }
    if (!added) {
      if (previous !== undefined) this.drafts.set(draftKey, previous)
      return
    }
    if (dateKey !== this.host.getDateKey()) {
      new Notice(
        this.host.tv('comments.savedOnNewDay', 'The date has changed, so the comment was saved for {date}.', {
          date: `${sentOn.getMonth() + 1}/${sentOn.getDate()}`,
        }),
      )
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

  /** The row's 💬: opens its comments, or closes them when they are open. One task's at a time. */
  togglePanel(inst: TaskInstance): void {
    if (!canCommentWhileRunning(inst)) return
    if (this.openInstanceId === inst.instanceId) {
      this.closePanel()
      return
    }
    this.openPanel(inst.instanceId)
  }

  private openPanel(key: string): void {
    this.openInstanceId = key
    if (this.host.isNarrow()) {
      this.host.rerender()
      return
    }
    this.panelEnter = true
    this.panelToEnd = true
    this.focusAfterRender(this.composeKey(key))
  }

  private closePanel(): void {
    const key = this.openInstanceId
    if (key === null) return
    this.openInstanceId = null
    // Cancels the refocus of an add still waiting for its frame.
    this.focusToken += 1
    this.host.rerender()
    // Back to the row's 💬, as the day's window goes back to its button.
    const rows = this.host.getRoot()?.querySelectorAll<HTMLElement>('.task-item[data-instance-id]') ?? []
    const row = Array.from(rows).find((el) => el.getAttribute('data-instance-id') === key)
    row?.querySelector<HTMLElement>('.comment-button')?.focus()
  }

  /**
   * What goes right after a row: while a running task's comments are open,
   * the popover or a narrow view's panel; otherwise, with the setting on, the
   * task's comments from while it ran (LEV-412).
   */
  renderPanel(inst: TaskInstance): HTMLElement | null {
    if (this.openInstanceId !== null && this.openInstanceId === inst.instanceId) {
      if (canCommentWhileRunning(inst)) {
        const key = inst.instanceId
        const comments = this.host.store.getComments({ instanceId: key, dateKey: this.host.getDateKey() })
        return this.host.isNarrow() ? this.narrowPanel(key, comments) : this.popover(key, comments)
      }
      // Stopped while open: it stays closed, rather than coming back by
      // itself if the task is reset and run again.
      this.openInstanceId = null
    }
    return this.rowComments(inst)
  }

  /**
   * A task's comments from while it ran, under its name, oldest first with
   * their times, for reading the day back (LEV-412). Only with the setting
   * on, and only for a task that has some; changing them is done in the
   * popover while it runs and in the completion dialog.
   */
  private rowComments(inst: TaskInstance): HTMLElement | null {
    if (!this.host.isRowCommentsEnabled() || !inst.instanceId) return null
    const comments = this.host.store.getComments({ instanceId: inst.instanceId, dateKey: this.host.getDateKey() })
    if (comments.length === 0) return null
    const box = createDiv({ cls: 'taskchute-row-comments' })
    box.setAttribute('data-instance-id', inst.instanceId)
    const ul = box.createEl('ul', { cls: 'taskchute-comment-list taskchute-row-comments__list' })
    for (const comment of [...comments].reverse()) createCommentItem(ul, comment, {})
    return box
  }

  /**
   * Under the row's 💬, laid out like the day's window. It hangs from an
   * anchor of no height placed after the row, so opening it moves no row,
   * and it scrolls with the list. It closes from ×, Esc or the 💬.
   */
  private popover(key: string, comments: DayComment[]): HTMLElement {
    const anchor = createDiv({ cls: 'taskchute-task-comments-anchor' })
    const parts = createCommentsWindow(anchor, {
      kind: 'popover',
      title: this.host.getInstanceTitle(key),
      count: comments.length > 0 ? this.host.tv('comments.count', '{count} comments', { count: comments.length }) : '',
      label: this.host.tv('comments.buttonTitle', 'Comments'),
      closeLabel: this.host.tv('comments.closeDay', 'Close the comments'),
      onClose: () => this.closePanel(),
    })
    // Only the opening draw animates: adding or deleting draws it again.
    if (this.panelEnter) parts.el.classList.add('is-entering')
    this.panelEnter = false
    if (comments.length === 0) {
      parts.body.createEl('p', { cls: 'taskchute-comment-empty', text: this.host.tv('comments.empty', 'No comments yet') })
    } else {
      // Oldest first, like a chat: each new one goes under the last.
      parts.body.appendChild(this.list([...comments].reverse()))
    }
    parts.composer.appendChild(
      this.windowInput({
        draftKey: key,
        focusKey: this.composeKey(key),
        placeholder: this.host.tv('comments.taskPlaceholder', 'Add a comment while working…'),
        submitOnEnter: true,
        onSubmit: (text) => void this.submit(key, text),
        onEscape: () => this.closePanel(),
      }),
    )
    parts.body.addEventListener('scroll', () => {
      this.panelScroll = parts.body.scrollTop
    })
    const toEnd = this.panelToEnd
    // The anchor joins the list after this returns; measure once it is in.
    // The scroll to the end is spent only by a popover still on screen, so a
    // second draw before this frame scrolls there too.
    window.requestAnimationFrame(() => {
      if (!anchor.isConnected) return
      pointAtCommentButton(anchor, parts.el)
      parts.body.scrollTop = toEnd ? parts.body.scrollHeight : this.panelScroll
      if (toEnd) this.panelToEnd = false
    })
    return anchor
  }

  /** A narrow view: a panel under the row, newest first, with a tap target that adds in a modal. */
  private narrowPanel(key: string, comments: DayComment[]): HTMLElement {
    const panel = createDiv({ cls: 'taskchute-task-comments' })
    panel.appendChild(this.tapComposer(key, this.host.tv('comments.taskPlaceholder', 'Add a comment while working…')))
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
      this.openPanel(instanceId)
      if (this.host.isNarrow()) this.openAddModal(instanceId)
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

  /**
   * The "leave a comment on the running task" command (LEV-415): with one
   * running task its comment opens at once, with several they are listed to
   * pick from, with none a notice says so. Always in a modal, so it works
   * over a note as well as over the task list.
   */
  leaveRunningComment(): void {
    const running = this.host.getRunningInstanceIds()
    if (running.length === 0) {
      new Notice(this.host.tv('comments.noRunningTask', 'No task is running.'))
      return
    }
    if (running.length === 1) {
      this.openAddModal(running[0])
      return
    }
    new RunningTaskSuggestModal(
      this.host.app,
      running.map((instanceId) => ({ instanceId, title: this.host.getInstanceTitle(instanceId) })),
      this.host.tv('comments.pickRunningTask', 'Which running task is this comment for?'),
      (choice) => this.openAddModal(choice.instanceId),
    ).open()
  }

  // --- a task's input ---------------------------------------------------------

  private composeKey(key: string): string {
    return `compose:${key}`
  }

  private async submit(key: string, text: string): Promise<void> {
    if (!text.trim() || this.sending.has(key)) return
    // Clear the draft first: adding re-renders.
    const previous = this.drafts.get(key)
    this.drafts.delete(key)
    this.sending.add(key)
    let added: DayComment | null
    try {
      added = await this.host.store.addCommentTo(this.host.getDateKey(), { text, instanceId: key })
    } finally {
      this.sending.delete(key)
    }
    if (!added) {
      if (previous !== undefined) this.drafts.set(key, previous)
      return
    }
    this.panelToEnd = true
    this.focusAfterRender(this.composeKey(key))
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
      submitOnEnter: !this.host.isPhone(),
      onSubmit: (text) => {
        if (!text.trim()) return false
        void this.submit(key, text).then(() => this.host.rerender())
        return true
      },
    }).open()
  }

  // --- the list and deleting -----------------------------------------------------

  /**
   * Time and text, in the order given, each with a button that rewrites it
   * in place (LEV-413) and one that deletes it. `limit` shows that many,
   * then a toggle for the rest.
   */
  private list(comments: DayComment[], options: { key?: string; limit?: number } = {}): HTMLElement {
    const wrapper = createDiv({ cls: 'taskchute-comment-entries' })
    const all = !options.limit || (options.key !== undefined && this.showAll.has(options.key))
    const shown = all ? comments : comments.slice(0, options.limit)
    const ul = wrapper.createEl('ul', { cls: 'taskchute-comment-list' })
    for (const comment of shown) {
      if (comment.id === this.editingId) {
        this.editor(ul, comment)
        continue
      }
      createCommentItem(ul, comment, {
        editLabel: this.host.tv('comments.editLabel', 'Edit this comment'),
        onEdit: () => this.startEdit(comment),
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

  // --- rewriting (LEV-413) -------------------------------------------------------

  private editKey(id: string): string {
    return `edit:${id}`
  }

  /** The comment's text in an input in its place, with its time kept. */
  private editor(list: HTMLElement, comment: DayComment): void {
    const key = this.editKey(comment.id)
    createCommentEditor(list, comment, {
      focusKey: this.composeKey(key),
      value: this.drafts.get(key) ?? comment.text,
      // A phone has no Shift: Enter is a new line there, and Save saves.
      submitOnEnter: !this.host.isPhone(),
      saveText: this.host.tv('comments.save', 'Save'),
      cancelText: this.host.tv('comments.cancel', 'Cancel'),
      onInput: (value) => this.drafts.set(key, value),
      onSave: (text) => this.saveEdit(comment.id, text),
      onCancel: () => this.cancelEdit(),
    })
  }

  private startEdit(comment: DayComment): void {
    // One at a time: another one being rewritten is dropped unsaved.
    if (this.editingId) this.drafts.delete(this.editKey(this.editingId))
    this.editingId = comment.id
    this.drafts.set(this.editKey(comment.id), comment.text)
    this.focusAfterRender(this.composeKey(this.editKey(comment.id)))
  }

  private saveEdit(id: string, text: string): void {
    this.editingId = null
    this.drafts.delete(this.editKey(id))
    // Emptied: that is a delete, with the same undo as the × button.
    if (!text.trim()) {
      this.deleteWithUndo(id)
      return
    }
    this.host.store.updateComment(id, text, this.host.getDateKey())
    this.host.rerender()
  }

  private cancelEdit(): void {
    if (this.editingId) this.drafts.delete(this.editKey(this.editingId))
    this.editingId = null
    this.focusToken += 1
    this.host.rerender()
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

  // --- focus ---------------------------------------------------------------------

  private focusAfterRender(focusKey: string, caret: 'end' | 'keep' = 'end'): void {
    this.host.rerender()
    const token = ++this.focusToken
    window.requestAnimationFrame(() => {
      // Closing (Esc) in the meantime cancels the refocus.
      if (token !== this.focusToken) return
      const root = this.host.getRoot()
      const target = root ? findFocusTarget(root, focusKey) : null
      if (!target) return
      target.focus()
      if (caret === 'end') target.setSelectionRange(target.value.length, target.value.length)
    })
  }
}

