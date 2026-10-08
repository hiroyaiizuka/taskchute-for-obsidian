import { Notice } from 'obsidian'
import { CommentsController, canCommentWhileRunning, type CommentsControllerHost } from '@/features/comments/CommentsController'
import DayStateStoreService from '@/services/DayStateStoreService'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import type { DayState, TaskInstance } from '@/types'

jest.mock('@/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn(),
}))

const DATE = '2026-10-07'

const emptyDay = (): DayState => ({
  hiddenRoutines: [],
  deletedInstances: [],
  duplicatedInstances: [],
  slotOverrides: {},
  orders: {},
})

const instance = (overrides: Partial<TaskInstance> & { instanceId: string }): TaskInstance =>
  ({
    state: 'running',
    slotKey: 'none',
    task: { path: 'TASKS/a.md', name: 'Write the plan', frontmatter: {} },
    ...overrides,
  }) as unknown as TaskInstance

async function setup(initial: DayState = emptyDay()) {
  const store = new DayStateStoreService({
    dayStateService: {
      loadDay: jest.fn(async () => initial),
      saveDay: jest.fn(async () => undefined),
      mergeDayState: jest.fn(),
      clearCache: jest.fn(),
      getDateFromKey: jest.fn(),
      renameTaskPath: jest.fn(),
    },
    getCurrentDateString: () => DATE,
    parseDateString: (key: string) => new Date(`${key}T00:00:00`),
  })
  await store.ensure(DATE)

  const root = document.createElement('div')
  document.body.appendChild(root)
  const dayBox = root.createDiv()
  const grip = root.createDiv()
  const list = root.createDiv()
  const instances: TaskInstance[] = []
  const local = new Map<string, unknown>()
  const narrow = { value: false }
  const dayEnabled = { value: true }

  // eslint-disable-next-line prefer-const -- assigned after the host that refers to it
  let controller: CommentsController
  const rerender = jest.fn(() => {
    list.empty()
    for (const inst of instances) {
      const panel = controller.renderPanel(inst)
      if (panel) list.appendChild(panel)
    }
    controller.renderDay()
  })
  const host: CommentsControllerHost = {
    app: {} as CommentsControllerHost['app'],
    tv: (_key, fallback, vars) =>
      vars ? fallback.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name])) : fallback,
    store,
    getDateKey: () => DATE,
    isViewingToday: () => true,
    getRoot: () => root,
    getTaskListContainer: () => list,
    rerender,
    getInstanceTitle: () => 'Write the plan',
    getCommandTargetInstanceId: () => instances.find(canCommentWhileRunning)?.instanceId ?? null,
    isNarrow: () => narrow.value,
    isDayCommentsEnabled: () => dayEnabled.value,
    loadLocalStorage: (key) => local.get(key) ?? null,
    saveLocalStorage: (key, value) => local.set(key, value),
    registerInterval: () => undefined,
    registerCleanup: () => undefined,
  }
  controller = new CommentsController(host)
  controller.mountDay(dayBox, grip)
  return { controller, store, root, dayBox, grip, list, instances, rerender, narrow, dayEnabled }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  jest.runOnlyPendingTimers()
}

describe('CommentsController', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(`${DATE}T03:00:00Z`) })
    ;(Notice as unknown as jest.Mock).mockImplementation(() => ({ hide: jest.fn() }))
    ;(showConfirmModal as jest.Mock).mockReset()
  })
  afterEach(() => {
    jest.useRealTimers()
    document.body.empty()
  })

  describe("the day's box", () => {
    it('shows only the input on a day from before comments existed, with the grip hidden', async () => {
      const { dayBox, grip } = await setup()
      expect(dayBox.querySelector('textarea')).not.toBeNull()
      expect(dayBox.querySelector('.taskchute-comment-list')).toBeNull()
      expect(grip.classList.contains('taskchute-day-comments-resizer--hidden')).toBe(true)
    })

    it('lists every comment newest first, with no show-more button', async () => {
      const { controller, store, dayBox, grip } = await setup()
      for (let i = 1; i <= 5; i += 1) {
        await store.addCommentTo(DATE, { text: `comment ${i}` })
        jest.advanceTimersByTime(60_000)
      }
      controller.renderDay()
      const texts = Array.from(dayBox.querySelectorAll('.taskchute-comment-text')).map((n) => n.textContent)
      expect(texts).toEqual(['comment 5', 'comment 4', 'comment 3', 'comment 2', 'comment 1'])
      expect(dayBox.querySelector('.taskchute-comment-toggle')).toBeNull()
      expect(grip.classList.contains('taskchute-day-comments-resizer--hidden')).toBe(false)
    })

    it('adds a comment with Enter and keeps the input open', async () => {
      const { dayBox, store } = await setup()
      const input = dayBox.querySelector('textarea')!
      input.value = 'remember the meeting'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['remember the meeting'])
      expect(dayBox.querySelector('textarea')!.value).toBe('')
    })

    it('does not add on Shift+Enter or while composing with an IME', async () => {
      const { dayBox, store } = await setup()
      const input = dayBox.querySelector('textarea')!
      input.value = 'line'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
      await flush()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
    })
  })

  describe("a running task's comments", () => {
    it('only takes comments on running human tasks', () => {
      expect(canCommentWhileRunning(instance({ instanceId: 'a' }))).toBe(true)
      expect(canCommentWhileRunning(instance({ instanceId: 'b', state: 'idle' }))).toBe(false)
      expect(canCommentWhileRunning(instance({ instanceId: 'c', state: 'done' }))).toBe(false)
      expect(
        canCommentWhileRunning(
          instance({ instanceId: 'd', task: { path: 'x', name: 'x', frontmatter: { ai_task: true } } as unknown as TaskInstance['task'] }),
        ),
      ).toBe(false)
    })

    it("gives the row's 💬 the count, and null for other tasks", async () => {
      const { controller, store } = await setup()
      const running = instance({ instanceId: 'i-1' })
      await store.addCommentTo(DATE, { text: 'x', instanceId: 'i-1' })
      expect(controller.commentButton(running)).toEqual({ count: 1, open: false })
      expect(controller.commentButton(instance({ instanceId: 'i-2', state: 'done' }))).toBeNull()
    })

    it('opens the panel under the row and keeps the day comments apart', async () => {
      const { controller, store, instances, list } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      await store.addCommentTo(DATE, { text: 'on the day' })
      controller.togglePanel(running)
      expect(controller.commentButton(running)?.open).toBe(true)
      const panel = list.querySelector('.taskchute-task-comments')!
      expect(panel.querySelector('.taskchute-comment-empty')).not.toBeNull()
      expect(panel.textContent).not.toContain('on the day')
    })

    it('shows three comments first, then a button for the rest', async () => {
      const { controller, store, instances, list } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      for (let i = 1; i <= 5; i += 1) {
        await store.addCommentTo(DATE, { text: `c${i}`, instanceId: 'i-1' })
        jest.advanceTimersByTime(60_000)
      }
      controller.togglePanel(running)
      const panel = () => list.querySelector('.taskchute-task-comments')!
      expect(panel().querySelectorAll('.taskchute-comment-list > li')).toHaveLength(3)
      const toggle = panel().querySelector<HTMLButtonElement>('.taskchute-comment-toggle')!
      expect(toggle.textContent).toBe('Show more (2)')
      toggle.click()
      expect(panel().querySelectorAll('.taskchute-comment-list > li')).toHaveLength(5)
    })
  })

  describe('rewriting and deleting', () => {
    it('rewrites a comment in place', async () => {
      const { store, dayBox, controller } = await setup()
      await store.addCommentTo(DATE, { text: 'draft' })
      controller.renderDay()
      dayBox.querySelector<HTMLElement>('.taskchute-comment-text')!.click()
      const editor = dayBox.querySelector<HTMLTextAreaElement>('.taskchute-comment-editor textarea')!
      editor.value = 'final'
      editor.dispatchEvent(new Event('input'))
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['final'])
      expect(dayBox.querySelector('.taskchute-comment-editor')).toBeNull()
    })

    it('deletes at once and brings it back from the undo notice', async () => {
      const { store, dayBox, controller } = await setup()
      await store.addCommentTo(DATE, { text: 'oops' })
      controller.renderDay()
      dayBox.querySelector<HTMLElement>('.taskchute-comment-text')!.click()
      const remove = Array.from(dayBox.querySelectorAll<HTMLButtonElement>('.taskchute-comment-editor button'))
        .find((b) => b.textContent === 'Delete')!
      remove.click()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
      const fragment = (Notice as unknown as jest.Mock).mock.calls.at(-1)[0] as DocumentFragment
      fragment.querySelector<HTMLButtonElement>('.taskchute-undo-notice__button')!.click()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['oops'])
    })
  })

  describe('Esc in the input', () => {
    it('is not undone by the refocus that follows adding a comment', async () => {
      const { dayBox } = await setup()
      const input = dayBox.querySelector('textarea')!
      input.value = 'added'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await Promise.resolve()
      await Promise.resolve()
      // Esc before the next frame, where adding schedules focus back into the input.
      const current = dayBox.querySelector<HTMLTextAreaElement>('textarea')!
      current.focus()
      current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      jest.runOnlyPendingTimers()
      expect(document.activeElement).not.toBe(dayBox.querySelector('textarea'))
    })

    it('leaves an empty input, which then closes', async () => {
      const { dayBox } = await setup()
      dayBox.querySelector('textarea')!.dispatchEvent(new Event('focus'))
      await flush()
      const opened = dayBox.querySelector<HTMLTextAreaElement>('.taskchute-comment-composer.is-open textarea')!
      opened.focus()
      opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(document.activeElement).not.toBe(opened)
      jest.advanceTimersByTime(200)
      expect(dayBox.querySelector('.taskchute-comment-composer.is-open')).toBeNull()
    })

    it('asks before throwing away unsaved text, and keeps it on cancel', async () => {
      const { dayBox } = await setup()
      dayBox.querySelector('textarea')!.dispatchEvent(new Event('focus'))
      await flush()
      const opened = dayBox.querySelector<HTMLTextAreaElement>('.taskchute-comment-composer.is-open textarea')!
      opened.focus()
      opened.value = 'half written'
      opened.dispatchEvent(new Event('input'))
      ;(showConfirmModal as jest.Mock).mockResolvedValue(false)
      opened.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      jest.advanceTimersByTime(200)
      await flush()
      expect(showConfirmModal).toHaveBeenCalledTimes(1)
      expect(dayBox.querySelector('textarea')!.value).toBe('half written')
    })
  })

  describe('only one input or editor open at a time', () => {
    it('closes an empty input when another opens', async () => {
      const { controller, dayBox, instances } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      dayBox.querySelector('textarea')!.dispatchEvent(new Event('focus'))
      expect(dayBox.querySelector('.taskchute-comment-composer.is-open')).not.toBeNull()
      controller.togglePanel(running)
      expect(dayBox.querySelector('.taskchute-comment-composer.is-open')).toBeNull()
    })

    it('asks before discarding unsaved text, and keeps it on cancel', async () => {
      const { controller, dayBox, instances } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      const input = dayBox.querySelector('textarea')!
      input.dispatchEvent(new Event('focus'))
      const opened = dayBox.querySelector('textarea')!
      opened.value = 'half written'
      opened.dispatchEvent(new Event('input'))
      ;(showConfirmModal as jest.Mock).mockResolvedValue(false)
      controller.togglePanel(running)
      await flush()
      expect(showConfirmModal).toHaveBeenCalledTimes(1)
      expect(dayBox.querySelector('textarea')!.value).toBe('half written')
    })
  })

  describe('a narrow view (a phone, or a narrow pane)', () => {
    it('makes the input a tap target that opens a modal for adding', async () => {
      const { controller, dayBox, store, narrow } = await setup()
      narrow.value = true
      controller.renderDay()
      expect(dayBox.querySelector('textarea')).toBeNull()
      dayBox.querySelector<HTMLButtonElement>('.taskchute-comment-tap')!.click()
      const modal = document.querySelector('.taskchute-comment-entry-modal')!
      expect(modal.querySelector('.modal-title')?.textContent).toBe('Add a comment for today')
      const text = modal.querySelector<HTMLTextAreaElement>('textarea')!
      text.value = 'from the phone'
      const add = Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Add')!
      add.click()
      await flush()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['from the phone'])
    })

    it('rewrites a comment in a modal, not in place', async () => {
      const { controller, dayBox, store, narrow } = await setup()
      await store.addCommentTo(DATE, { text: 'draft' })
      narrow.value = true
      controller.renderDay()
      dayBox.querySelector<HTMLElement>('.taskchute-comment-text')!.click()
      expect(dayBox.querySelector('.taskchute-comment-editor')).toBeNull()
      const modal = document.querySelector('.taskchute-comment-entry-modal')!
      expect(modal.querySelector('.modal-title')?.textContent).toBe('Edit comment')
      modal.querySelector<HTMLTextAreaElement>('textarea')!.value = 'final'
      Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Save')!.click()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['final'])
    })

    it("opens a running task's panel without focusing an input", async () => {
      const { controller, instances, list, narrow } = await setup()
      narrow.value = true
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      controller.togglePanel(running)
      expect(list.querySelector('.taskchute-task-comments .taskchute-comment-tap')).not.toBeNull()
      expect(document.querySelector('.taskchute-comment-entry-modal')).toBeNull()
    })
  })

  describe("the setting for the day's box (off by default)", () => {
    it('draws no box and no grip when off, even with comments stored', async () => {
      const { controller, store, dayBox, grip, dayEnabled } = await setup()
      await store.addCommentTo(DATE, { text: 'kept while hidden' })
      dayEnabled.value = false
      controller.renderDay()
      expect(dayBox.childElementCount).toBe(0)
      expect(dayBox.classList.contains('taskchute-day-comments--off')).toBe(true)
      expect(grip.classList.contains('taskchute-day-comments-resizer--hidden')).toBe(true)

      dayEnabled.value = true
      controller.renderDay()
      expect(dayBox.classList.contains('taskchute-day-comments--off')).toBe(false)
      expect(dayBox.querySelector('.taskchute-comment-text')?.textContent).toBe('kept while hidden')
    })

    it("still takes comments on a running task when the day's box is off", async () => {
      const { controller, instances, list, dayEnabled } = await setup()
      dayEnabled.value = false
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      controller.togglePanel(running)
      expect(list.querySelector('.taskchute-task-comments textarea')).not.toBeNull()
    })

    it('"Leave a comment" with no running task explains what to do instead of opening anything', async () => {
      const { controller, dayEnabled, dayBox } = await setup()
      dayEnabled.value = false
      controller.renderDay()
      controller.leaveComment()
      expect(Notice).toHaveBeenCalledWith('Start a task to comment on it, or turn on comments for the day in settings.')
      expect(dayBox.querySelector('textarea')).toBeNull()
    })
  })
})
