import { Notice, type App } from 'obsidian'
import type { ScopedTranslator } from '@/i18n'
import type { DayComment, TaskInstance } from '@/types'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import { CommentModal } from './ui/CommentModal'
import { DayCommentsHeight } from './ui/DayCommentsHeight'
import {
  NOW_ATTR,
  createCommentTextarea,
  findFocusTarget,
  formatCommentTime,
} from './ui/commentDom'
import { showUndoNotice } from './ui/undoNotice'

/** The input on the day; any other key is an instance id. */
const DAY = 'day'
/** A task's panel shows this many, then a button for the rest. */
const TASK_PREVIEW = 3
const NOW_TICK_MS = 10_000

export interface CommentStore {
  getComments(options: { instanceId?: string; dateKey?: string }): DayComment[]
  addCommentTo(dateKey: string, input: { text: string; instanceId?: string }): Promise<DayComment | null>
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
  /** The view's root, for focus and the clocks of open inputs. */
  getRoot: () => HTMLElement | null
  getTaskListContainer: () => HTMLElement | null
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
  /** The setting for the day's box; off by default. Running tasks take comments either way. */
  isDayCommentsEnabled: () => boolean
  loadLocalStorage: (key: string) => unknown
  saveLocalStorage: (key: string, value: unknown) => void
  registerInterval: (id: number) => void
  registerCleanup: (cleanup: () => void) => void
}

interface EditingState {
  id: string
  draft: string
  original: string
}

/** Comments are kept for running human tasks; an AI task's run has its own log. */
export function canCommentWhileRunning(inst: TaskInstance): boolean {
  return inst.state === 'running' && Boolean(inst.instanceId) && inst.task?.frontmatter?.['ai_task'] !== true
}

/**
 * Comments written while working (#181, proposal E): the day's comments in a
 * box between the header and the task list, and a running task's comments in
 * a panel under its row, opened by the row's 💬. Both lists show time and
 * text, newest first. Only one input or editor is open at a time.
 */
export class CommentsController {
  private readonly drafts = new Map<string, string>()
  /** Inputs opened by focus, by key. */
  private readonly composing = new Set<string>()
  private editing: EditingState | null = null
  private openInstanceId: string | null = null
  private readonly showAll = new Set<string>()
  /** A confirm modal is up; focus moving into it must not close anything. */
  private confirming = false
  private dayBox: HTMLElement | null = null
  private dayGrip: HTMLElement | null = null
  private height: DayCommentsHeight | null = null

  constructor(private readonly host: CommentsControllerHost) {}

  /** Takes the box above the task list and the grip under it. */
  mountDay(box: HTMLElement, grip: HTMLElement): void {
    this.dayBox = box
    this.dayGrip = grip
    box.setAttribute('aria-label', this.host.tv('comments.regionLabel', 'Comments for the day'))
    grip.setAttribute('role', 'separator')
    grip.setAttribute('aria-orientation', 'horizontal')
    grip.setAttribute('tabindex', '0')
    grip.setAttribute('title', this.host.tv('comments.resizerLabel', 'Drag to fix the height'))
    this.height = new DayCommentsHeight(box, grip, {
      loadLocalStorage: (key) => this.host.loadLocalStorage(key),
      saveLocalStorage: (key, value) => this.host.saveLocalStorage(key, value),
      getTaskListContainer: () => this.host.getTaskListContainer(),
    })
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
      this.editing = null
      this.host.rerender()
    })
    observer.observe(root)
    this.host.registerCleanup(() => observer.disconnect())
  }

  // --- the day's box ---------------------------------------------------------

  renderDay(): void {
    const box = this.dayBox
    if (!box) return
    const enabled = this.host.isDayCommentsEnabled()
    box.classList.toggle('taskchute-day-comments--off', !enabled)
    if (!enabled) {
      // Turned off in settings: no box and no grip. A draft stays for when it is turned back on.
      box.empty()
      this.composing.delete(DAY)
      this.dayGrip?.classList.add('taskchute-day-comments-resizer--hidden')
      return
    }
    const previousScroll = box.querySelector('.taskchute-day-comments__entries')?.scrollTop ?? 0
    box.empty()
    const placeholder = this.host.isViewingToday()
      ? this.host.tv('comments.dayPlaceholder', 'Add a comment for today…')
      : this.host.tv('comments.otherDayPlaceholder', 'Add a comment for this day…')
    box.appendChild(this.composer(DAY, placeholder))
    const comments = this.host.store.getComments({ dateKey: this.host.getDateKey() })
    if (comments.length > 0) {
      const scroller = box.createDiv({ cls: 'taskchute-day-comments__entries' })
      scroller.appendChild(this.list(comments))
      scroller.scrollTop = previousScroll
    }
    this.height?.apply()
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

  /** The "leave a comment" command: the running task's input, or else the day's. */
  leaveComment(): void {
    const instanceId = this.host.getCommandTargetInstanceId()
    if (!instanceId && !this.host.isDayCommentsEnabled()) {
      new Notice(
        this.host.tv(
          'comments.noTarget',
          'Start a task to comment on it, or turn on comments for the day in settings.',
        ),
      )
      return
    }
    if (instanceId) this.openInstanceId = instanceId
    const key = instanceId ?? DAY
    if (this.host.isNarrow()) {
      this.host.rerender()
      this.openAddModal(key)
      return
    }
    this.openComposer(key)
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
    return createCommentTextarea(parent, {
      cls: 'taskchute-comment-input',
      focusKey: this.composeKey(key),
      value: this.drafts.get(key) ?? '',
      placeholder,
      onInput: (value) => this.drafts.set(key, value),
      onSubmit: submit,
    })
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
    const added = await this.host.store.addCommentTo(this.host.getDateKey(), {
      text,
      instanceId: key === DAY ? undefined : key,
    })
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
   * Only one input or editor is open at a time. Before `open` runs the others
   * close; when one of them holds unsaved text, ask first. Cancel goes back
   * to that one. `except` is the input being opened.
   */
  private openOnly(open: () => void, except?: string): void {
    const dirtyInputs = Array.from(this.composing).filter((k) => k !== except && this.drafts.get(k)?.trim())
    const editorDirty = this.editing !== null && this.editing.draft.trim() !== this.editing.original.trim()
    const closeOthers = () => {
      for (const k of Array.from(this.composing)) {
        if (k === except) continue
        this.composing.delete(k)
        this.drafts.delete(k)
      }
      this.editing = null
    }
    if (dirtyInputs.length === 0 && !editorDirty) {
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
      const back = dirtyInputs[0] ? this.composeKey(dirtyInputs[0]) : this.editing ? this.editKey(this.editing.id) : null
      if (back) this.focusAfterRender(back)
      else this.host.rerender()
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

  private openAddModal(key: string): void {
    const title = key === DAY
      ? this.host.isViewingToday()
        ? this.host.tv('comments.addDayTitle', 'Add a comment for today')
        : this.host.tv('comments.addOtherDayTitle', 'Add a comment for this day')
      : this.host.tv('comments.addTaskTitle', 'Add a comment to "{title}"', { title: this.host.getInstanceTitle(key) })
    new CommentModal(this.host.app, {
      title,
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

  private openEditModal(comment: DayComment): void {
    new CommentModal(this.host.app, {
      title: this.host.tv('comments.editTitle', 'Edit comment'),
      at: comment.at,
      value: comment.text,
      submitText: this.host.tv('comments.save', 'Save'),
      cancelText: this.host.tv('comments.cancel', 'Cancel'),
      deleteText: this.host.tv('comments.delete', 'Delete'),
      onSubmit: (text) => this.saveText(comment.id, text),
      onDelete: () => this.deleteWithUndo(comment.id),
    }).open()
  }

  // --- the list and rewriting ----------------------------------------------------

  private editKey(id: string): string {
    return `edit:${id}`
  }

  /** Time and text, newest first. `limit` shows that many, then a toggle for the rest. */
  private list(comments: DayComment[], options: { key?: string; limit?: number } = {}): HTMLElement {
    const wrapper = createDiv({ cls: 'taskchute-comment-entries' })
    const all = !options.limit || (options.key !== undefined && this.showAll.has(options.key))
    const shown = all ? comments : comments.slice(0, options.limit)
    const ul = wrapper.createEl('ul', { cls: 'taskchute-comment-list' })
    for (const comment of shown) {
      if (this.editing?.id === comment.id && !this.host.isNarrow()) {
        ul.createEl('li', { cls: 'is-editing' }).appendChild(this.editor(comment))
        continue
      }
      const li = ul.createEl('li')
      li.createEl('time', { text: formatCommentTime(comment.at) })
      const text = li.createSpan({
        cls: 'taskchute-comment-text',
        text: comment.text,
        attr: { role: 'button', tabindex: '0', title: this.host.tv('comments.editTooltip', 'Click to rewrite') },
      })
      text.addEventListener('click', () => this.startEdit(comment))
      text.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return
        event.preventDefault()
        this.startEdit(comment)
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

  private startEdit(comment: DayComment): void {
    if (this.host.isNarrow()) {
      this.openEditModal(comment)
      return
    }
    if (this.editing?.id === comment.id) return
    this.openOnly(() => {
      this.editing = { id: comment.id, draft: comment.text, original: comment.text }
      this.focusAfterRender(this.editKey(comment.id), 'end')
    })
  }

  /** Laid out like the open input: time and text, then the hint and the buttons. */
  private editor(comment: DayComment): HTMLElement {
    const editing = this.editing!
    const box = createDiv({ cls: 'taskchute-comment-editor' })
    const body = box.createDiv({ cls: 'taskchute-comment-composer__body' })
    body.createEl('time', { cls: 'taskchute-comment-composer__now', text: formatCommentTime(comment.at) })
    const textarea = createCommentTextarea(body, {
      cls: 'taskchute-comment-input',
      focusKey: this.editKey(comment.id),
      value: editing.draft,
      maxHeight: 320,
      onInput: (value) => {
        if (this.editing) this.editing.draft = value
      },
      onSubmit: (value) => this.finishEdit(comment.id, value),
      onEscape: () => this.cancelEdit(),
    })
    const foot = box.createDiv({ cls: 'taskchute-comment-composer__foot' })
    foot.createSpan({ cls: 'taskchute-comment-hint', text: this.host.tv('comments.editHint', 'Enter to save · Esc to cancel') })
    const actions = foot.createDiv({ cls: 'taskchute-comment-editor__actions' })
    const cancel = actions.createEl('button', { text: this.host.tv('comments.cancel', 'Cancel') })
    cancel.addEventListener('click', () => this.cancelEdit())
    const remove = actions.createEl('button', { cls: 'mod-warning', text: this.host.tv('comments.delete', 'Delete') })
    remove.addEventListener('click', () => {
      this.editing = null
      this.deleteWithUndo(comment.id)
    })
    const save = actions.createEl('button', { cls: 'mod-cta', text: this.host.tv('comments.save', 'Save') })
    save.addEventListener('click', () => this.finishEdit(comment.id, textarea.value))
    return box
  }

  private cancelEdit(): void {
    this.editing = null
    this.host.rerender()
  }

  private finishEdit(id: string, text: string): void {
    this.editing = null
    this.saveText(id, text)
  }

  /** Saving blank text deletes the comment (with undo). */
  private saveText(id: string, text: string): boolean {
    if (!text.trim()) {
      this.deleteWithUndo(id)
      return true
    }
    this.host.store.updateComment(id, text, this.host.getDateKey())
    this.host.rerender()
    return true
  }

  /** Deletes at once and offers undo in a notice instead of asking first. */
  private deleteWithUndo(id: string): void {
    const dateKey = this.host.getDateKey()
    const removed = this.host.store.deleteComment(id, dateKey)
    this.host.rerender()
    if (!removed) return
    showUndoNotice(
      this.host.tv('comments.deleted', 'Comment deleted'),
      this.host.tv('comments.undo', 'Undo'),
      () => {
        this.host.store.restoreComment(id, dateKey)
        this.host.rerender()
      },
    )
  }

  // --- focus and clocks ----------------------------------------------------------

  private focusAfterRender(focusKey: string, caret: 'end' | 'keep' = 'end'): void {
    this.host.rerender()
    window.requestAnimationFrame(() => {
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

