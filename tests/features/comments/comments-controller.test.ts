import { Notice } from 'obsidian'
import { CommentsController, canCommentWhileRunning, type CommentsControllerHost } from '@/features/comments/CommentsController'
import DayStateStoreService from '@/services/DayStateStoreService'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import type { DayState, TaskInstance } from '@/types'

jest.mock('@/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn(),
}))

const DATE = '2026-10-07'
const OTHER_DATE = '2026-10-06'

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
  const area = root.createDiv({ cls: 'taskchute-list-area' })
  const list = area.createDiv()
  const instances: TaskInstance[] = []
  const narrow = { value: false }
  const phone = { value: false }
  const dayEnabled = { value: true }
  const day = { key: DATE, today: true, label: '10/7 Wed' }

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
    getDateKey: () => day.key,
    isViewingToday: () => day.today,
    getRoot: () => root,
    getDayLabel: () => day.label,
    rerender,
    getInstanceTitle: () => 'Write the plan',
    getCommandTargetInstanceId: () => instances.find(canCommentWhileRunning)?.instanceId ?? null,
    isNarrow: () => narrow.value,
    isPhone: () => phone.value,
    isDayCommentsEnabled: () => dayEnabled.value,
    registerCleanup: () => undefined,
  }
  controller = new CommentsController(host)
  controller.mountDay(area)

  const button = () => area.querySelector<HTMLButtonElement>('.taskchute-day-comments-button')!
  const win = () => root.querySelector<HTMLElement>('.taskchute-day-comments-window')
  const dayInput = () => win()!.querySelector<HTMLTextAreaElement>('.taskchute-day-comments-window__input textarea')!
  const dayCount = () => win()?.querySelector('.taskchute-day-comments-window__count')?.textContent ?? null
  const dayTexts = () => Array.from(win()?.querySelectorAll('.taskchute-comment-text') ?? []).map((n) => n.textContent)
  const open = () => {
    button().click()
    rerender()
  }
  return { controller, store, root, area, list, instances, rerender, narrow, phone, dayEnabled, day, button, win, dayInput, dayCount, dayTexts, open }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  jest.runOnlyPendingTimers()
}

const type = (input: HTMLTextAreaElement, text: string) => {
  input.value = text
  input.dispatchEvent(new Event('input'))
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

  describe("the day's button", () => {
    it('sits over the task list, closed', async () => {
      const { button, win } = await setup()
      expect(button().hidden).toBe(false)
      expect(win()).toBeNull()
    })

    it("carries no count; the window counts the day the view shows", async () => {
      const { store, controller, button, day, open, dayCount } = await setup()
      await store.addCommentTo(DATE, { text: 'one' })
      await store.addCommentTo(DATE, { text: 'two' })
      controller.renderDay()
      expect(button().textContent).toBe('')
      open()
      expect(dayCount()).toBe('2 comments')

      await store.ensure(OTHER_DATE)
      day.key = OTHER_DATE
      controller.renderDay()
      expect(dayCount()).toBeNull()
    })

    it('is not drawn when the setting is off, and the window closes', async () => {
      const { store, controller, button, win, open, dayEnabled, dayTexts } = await setup()
      await store.addCommentTo(DATE, { text: 'kept while hidden' })
      open()
      expect(win()).not.toBeNull()
      dayEnabled.value = false
      controller.renderDay()
      expect(button().hidden).toBe(true)
      expect(win()).toBeNull()

      dayEnabled.value = true
      controller.renderDay()
      expect(button().hidden).toBe(false)
      open()
      expect(dayTexts()).toEqual(['kept while hidden'])
    })
  })

  describe("the day's window", () => {
    it('opens from the button with the input focused, listing comments oldest first', async () => {
      const { store, open, win, dayTexts, dayInput } = await setup()
      for (let i = 1; i <= 3; i += 1) {
        await store.addCommentTo(DATE, { text: `comment ${i}` })
        jest.advanceTimersByTime(60_000)
      }
      open()
      jest.runOnlyPendingTimers()
      expect(win()!.querySelector('.taskchute-day-comments-window__title-text')?.textContent).toBe("Today's comments")
      expect(win()!.querySelector('.taskchute-day-comments-window__count')?.textContent).toBe('3 comments')
      expect(dayTexts()).toEqual(['comment 1', 'comment 2', 'comment 3'])
      expect(document.activeElement).toBe(dayInput())
    })

    it('shows no key hint under the input; the keys still work (LEV-367)', async () => {
      const { open, win, dayInput, store } = await setup()
      open()
      expect(win()!.querySelector('.taskchute-comment-hint')).toBeNull()
      type(dayInput(), 'still added with Enter')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['still added with Enter'])
    })

    it('on another day, says which day it shows and lists its comments without an input', async () => {
      const { store, open, win, day, dayTexts } = await setup()
      await store.ensure(OTHER_DATE)
      await store.addCommentTo(OTHER_DATE, { text: 'written yesterday' })
      day.key = OTHER_DATE
      day.today = false
      day.label = '10/6 Tue'
      open()
      expect(win()!.querySelector('.taskchute-day-comments-window__title-text')?.textContent).toBe('Comments for 10/6 Tue')
      expect(dayTexts()).toEqual(['written yesterday'])
      expect(win()!.querySelector('textarea')).toBeNull()
      expect(win()!.querySelector('.taskchute-day-comments-window__only-today')?.textContent).toBe('Comments can be added only for today.')
    })

    it('shows the empty state on a day without comments', async () => {
      const { open, win } = await setup()
      open()
      expect(win()!.querySelector('.taskchute-comment-empty')).not.toBeNull()
    })

    it('adds with Enter, stays open, and the count follows', async () => {
      const { store, open, dayInput, win, dayCount } = await setup()
      open()
      type(dayInput(), 'remember the meeting')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['remember the meeting'])
      expect(win()).not.toBeNull()
      expect(dayInput().value).toBe('')
      expect(dayCount()).toBe('1 comments')
    })

    it('keeps a comment sent past midnight on the new day, and says so', async () => {
      jest.setSystemTime(new Date(2026, 9, 7, 23, 59))
      const { store, open, dayInput, dayTexts } = await setup()
      open()
      type(dayInput(), 'written before midnight, sent after')
      jest.setSystemTime(new Date(2026, 9, 8, 0, 1))
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: '2026-10-08' }).map((c) => c.text)).toEqual(['written before midnight, sent after'])
      expect(store.getComments({ dateKey: DATE })).toEqual([])
      expect(dayTexts()).toEqual([])
      expect(Notice).toHaveBeenCalledWith('The date has changed, so the comment was saved for 10/8.')
    })

    it('does not add on Shift+Enter, while composing with an IME, or when blank', async () => {
      const { store, open, dayInput } = await setup()
      open()
      type(dayInput(), 'line')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
      type(dayInput(), '   ')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
    })

    it('closes from ×, from the button, and with Esc, keeping the focus on the button', async () => {
      const { open, win, button, dayInput, rerender } = await setup()
      open()
      win()!.querySelector<HTMLButtonElement>('.taskchute-day-comments-window__close')!.click()
      expect(win()).toBeNull()
      expect(document.activeElement).toBe(button())

      open()
      button().click()
      rerender()
      expect(win()).toBeNull()

      open()
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(win()).toBeNull()
    })

    it('is not reopened by the refocus that follows adding when Esc comes first', async () => {
      const { open, dayInput, win } = await setup()
      open()
      type(dayInput(), 'added')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await Promise.resolve()
      await Promise.resolve()
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      jest.runOnlyPendingTimers()
      expect(win()).toBeNull()
    })

    it('keeps an unsent draft through closing and a look at another day', async () => {
      const { open, dayInput, win, controller, day, store } = await setup()
      await store.ensure(OTHER_DATE)
      open()
      type(dayInput(), 'half written')
      win()!.querySelector<HTMLButtonElement>('.taskchute-day-comments-window__close')!.click()
      open()
      expect(dayInput().value).toBe('half written')

      day.key = OTHER_DATE
      day.today = false
      controller.renderDay()
      expect(win()!.querySelector('textarea')).toBeNull()
      day.key = DATE
      day.today = true
      controller.renderDay()
      expect(dayInput().value).toBe('half written')
      expect(showConfirmModal).not.toHaveBeenCalled()
    })

    it('cannot rewrite a comment: clicking it opens nothing', async () => {
      const { store, open, win } = await setup()
      await store.addCommentTo(DATE, { text: 'typo here' })
      open()
      win()!.querySelector<HTMLElement>('.taskchute-comment-text')!.click()
      expect(win()!.querySelector('.taskchute-comment-editor')).toBeNull()
      expect(document.querySelector('.taskchute-comment-entry-modal')).toBeNull()
      expect(win()!.querySelectorAll('textarea')).toHaveLength(1)
    })

    it('deletes from the × at once and brings it back from the undo notice', async () => {
      const { store, open, win, dayTexts } = await setup()
      await store.addCommentTo(DATE, { text: 'oops' })
      open()
      win()!.querySelector<HTMLButtonElement>('.taskchute-comment-delete')!.click()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
      expect(dayTexts()).toEqual([])
      const fragment = (Notice as unknown as jest.Mock).mock.calls.at(-1)[0] as DocumentFragment
      fragment.querySelector<HTMLButtonElement>('.taskchute-undo-notice__button')!.click()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['oops'])
      expect(dayTexts()).toEqual(['oops'])
    })

    it("deletes a past day's comment too", async () => {
      const { store, open, win, day } = await setup()
      await store.ensure(OTHER_DATE)
      await store.addCommentTo(OTHER_DATE, { text: 'old' })
      day.key = OTHER_DATE
      day.today = false
      open()
      win()!.querySelector<HTMLButtonElement>('.taskchute-comment-delete')!.click()
      expect(store.getComments({ dateKey: OTHER_DATE })).toEqual([])
    })
  })

  describe('on a phone', () => {
    it('opens a drawer over the whole view, without bringing up the keyboard', async () => {
      const { phone, open, win, root, dayInput } = await setup()
      phone.value = true
      open()
      jest.runOnlyPendingTimers()
      expect(win()!.classList.contains('is-drawer')).toBe(true)
      expect(win()!.parentElement).toBe(root)
      expect(document.activeElement).not.toBe(dayInput())
    })

    it('keeps Enter for new lines and adds with the button', async () => {
      const { phone, open, dayInput, win, store } = await setup()
      phone.value = true
      open()
      type(dayInput(), 'line one')
      dayInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
      win()!.querySelector<HTMLButtonElement>('.taskchute-comment-composer__add')!.click()
      await flush()
      expect(store.getComments({ dateKey: DATE }).map((c) => c.text)).toEqual(['line one'])
    })

    it('has the × on each comment in the drawer', async () => {
      const { phone, open, win, store } = await setup()
      phone.value = true
      await store.addCommentTo(DATE, { text: 'from the phone' })
      open()
      win()!.querySelector<HTMLButtonElement>('.taskchute-comment-delete')!.click()
      expect(store.getComments({ dateKey: DATE })).toEqual([])
    })
  })

  describe('"Leave a comment" (the command)', () => {
    it("opens the day's window when no task is running", async () => {
      const { controller, win, rerender } = await setup()
      controller.leaveComment()
      rerender()
      expect(win()).not.toBeNull()
    })

    it('opens the running task instead when there is one', async () => {
      const { controller, instances, list, win } = await setup()
      instances.push(instance({ instanceId: 'i-1' }))
      controller.leaveComment()
      expect(list.querySelector('.taskchute-task-comments-popover textarea')).not.toBeNull()
      expect(win()).toBeNull()
    })

    it('explains what to do when nothing can take a comment', async () => {
      const { controller, dayEnabled, win } = await setup()
      dayEnabled.value = false
      controller.renderDay()
      controller.leaveComment()
      expect(Notice).toHaveBeenCalledWith('Start a task to comment on it, or turn on comments for the day in settings.')
      expect(win()).toBeNull()
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

    it("opens a popover under the row's 💬, titled with the task, and keeps the day's comments apart", async () => {
      const { controller, store, instances, list, open, dayTexts, win } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      await store.addCommentTo(DATE, { text: 'on the day' })
      await store.addCommentTo(DATE, { text: 'on the task', instanceId: 'i-1' })
      controller.togglePanel(running)
      expect(controller.commentButton(running)?.open).toBe(true)
      const popover = list.querySelector('.taskchute-task-comments-anchor > .taskchute-task-comments-popover')!
      expect(popover.querySelector('.taskchute-day-comments-window__title-text')?.textContent).toBe('Write the plan')
      expect(popover.querySelector('.taskchute-day-comments-window__count')?.textContent).toBe('1 comments')
      expect(popover.textContent).toContain('on the task')
      expect(popover.textContent).not.toContain('on the day')
      // Not the day's window, though it is dressed like it.
      expect(win()).toBeNull()
      // The day's window holds the day's own comments; a task's stay with its row.
      open()
      expect(dayTexts()).toEqual(['on the day'])
    })

    it('lists every comment oldest first, the newest just above the input', async () => {
      const { controller, store, instances, list } = await setup()
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      for (let i = 1; i <= 5; i += 1) {
        await store.addCommentTo(DATE, { text: `c${i}`, instanceId: 'i-1' })
        jest.advanceTimersByTime(60_000)
      }
      controller.togglePanel(running)
      const popover = list.querySelector('.taskchute-task-comments-popover')!
      const texts = Array.from(popover.querySelectorAll('.taskchute-comment-text')).map((n) => n.textContent)
      expect(texts).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
      expect(popover.querySelector('.taskchute-comment-toggle')).toBeNull()
      expect(popover.lastElementChild?.classList.contains('taskchute-day-comments-window__composer')).toBe(true)
    })

    it('still takes comments when the setting for the day is off', async () => {
      const { controller, instances, list, dayEnabled } = await setup()
      dayEnabled.value = false
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      controller.togglePanel(running)
      expect(list.querySelector('.taskchute-task-comments-popover textarea')).not.toBeNull()
    })
  })

  describe("a running task's popover", () => {
    const openPopover = async () => {
      const ctx = await setup()
      const running = instance({ instanceId: 'i-1' })
      ctx.instances.push(running)
      ctx.controller.togglePanel(running)
      await flush()
      const popover = () => ctx.list.querySelector<HTMLElement>('.taskchute-task-comments-popover')
      const input = () => popover()!.querySelector<HTMLTextAreaElement>('textarea')!
      const texts = () => Array.from(popover()?.querySelectorAll('.taskchute-comment-text') ?? []).map((n) => n.textContent)
      return { ...ctx, running, popover, input, texts }
    }

    it('opens with its input focused, open from the start: nothing grows on focus', async () => {
      const { input, popover } = await openPopover()
      expect(document.activeElement).toBe(input())
      expect(popover()!.querySelector('.taskchute-day-comments-window__composer textarea')).toBe(input())
    })

    it('adds with Enter to the bottom of the list, and stays open with the input cleared and focused', async () => {
      const { input, texts, popover } = await openPopover()
      type(input(), 'first')
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      jest.advanceTimersByTime(60_000)
      type(input(), 'second')
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(texts()).toEqual(['first', 'second'])
      expect(popover()!.querySelector('.taskchute-day-comments-window__count')?.textContent).toBe('2 comments')
      expect(input().value).toBe('')
      expect(document.activeElement).toBe(input())
    })

    it('closes from ×, Esc and the 💬, keeping an unsent draft for next time without asking', async () => {
      const { controller, running, popover, input } = await openPopover()
      type(input(), 'half written')
      popover()!.querySelector<HTMLButtonElement>('.taskchute-day-comments-window__close')!.click()
      expect(popover()).toBeNull()
      expect(controller.commentButton(running)?.open).toBe(false)

      controller.togglePanel(running)
      await flush()
      expect(input().value).toBe('half written')
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(popover()).toBeNull()

      controller.togglePanel(running)
      await flush()
      controller.togglePanel(running)
      expect(popover()).toBeNull()
      expect(showConfirmModal).not.toHaveBeenCalled()
    })

    it("gives the focus back to the row's 💬 when it closes", async () => {
      const { root, popover } = await openPopover()
      const button = root.createDiv({ cls: 'task-item', attr: { 'data-instance-id': 'i-1' } }).createEl('button', { cls: 'comment-button' })
      popover()!.querySelector<HTMLButtonElement>('.taskchute-day-comments-window__close')!.click()
      expect(document.activeElement).toBe(button)
    })

    it('stays closed after its task stops, even when the task runs again', async () => {
      const { controller, running, popover, rerender } = await openPopover()
      running.state = 'done'
      rerender()
      expect(popover()).toBeNull()
      running.state = 'running'
      rerender()
      expect(popover()).toBeNull()
      expect(controller.commentButton(running)?.open).toBe(false)
    })

    it('adds once when Enter is pressed again before the first add is saved', async () => {
      const { store, input } = await openPopover()
      type(input(), 'only once')
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await flush()
      expect(store.getComments({ instanceId: 'i-1', dateKey: DATE }).map((c) => c.text)).toEqual(['only once'])
    })

    it("moves to another task's 💬, each task keeping its own draft", async () => {
      const { controller, instances, running, input, list } = await openPopover()
      const second = instance({ instanceId: 'i-2' })
      instances.push(second)
      type(input(), 'for the first')
      controller.togglePanel(second)
      await flush()
      expect(controller.commentButton(second)?.open).toBe(true)
      expect(list.querySelectorAll('.taskchute-task-comments-popover')).toHaveLength(1)
      expect(input().value).toBe('')
      controller.togglePanel(running)
      await flush()
      expect(input().value).toBe('for the first')
    })
  })

  describe('a narrow view (a phone, or a narrow pane)', () => {
    it("opens a panel under the row instead, newest first: three, then a button for the rest", async () => {
      const { controller, store, instances, list, narrow } = await setup()
      narrow.value = true
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      for (let i = 1; i <= 5; i += 1) {
        await store.addCommentTo(DATE, { text: `c${i}`, instanceId: 'i-1' })
        jest.advanceTimersByTime(60_000)
      }
      controller.togglePanel(running)
      expect(list.querySelector('.taskchute-task-comments-popover')).toBeNull()
      const panel = () => list.querySelector('.taskchute-task-comments')!
      const texts = () => Array.from(panel().querySelectorAll('.taskchute-comment-text')).map((n) => n.textContent)
      expect(texts()).toEqual(['c5', 'c4', 'c3'])
      const toggle = panel().querySelector<HTMLButtonElement>('.taskchute-comment-toggle')!
      expect(toggle.textContent).toBe('Show more (2)')
      toggle.click()
      expect(texts()).toHaveLength(5)
    })

    it("makes a task's input a tap target that opens a modal for adding", async () => {
      const { controller, instances, list, store, narrow } = await setup()
      narrow.value = true
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      controller.togglePanel(running)
      expect(list.querySelector('.taskchute-task-comments textarea')).toBeNull()
      expect(document.querySelector('.taskchute-comment-entry-modal')).toBeNull()
      list.querySelector<HTMLButtonElement>('.taskchute-comment-tap')!.click()
      const modal = document.querySelector('.taskchute-comment-entry-modal')!
      expect(modal.querySelector('.modal-title')?.textContent).toBe('Add a comment to "Write the plan"')
      modal.querySelector<HTMLTextAreaElement>('textarea')!.value = 'from the phone'
      Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Add')!.click()
      await flush()
      expect(store.getComments({ instanceId: 'i-1', dateKey: DATE }).map((c) => c.text)).toEqual(['from the phone'])
    })

    it("deletes a task's comment from its panel; there is no editor (LEV-347)", async () => {
      const { controller, instances, list, store, narrow } = await setup()
      narrow.value = true
      const running = instance({ instanceId: 'i-1' })
      instances.push(running)
      await store.addCommentTo(DATE, { text: 'draft', instanceId: 'i-1' })
      controller.togglePanel(running)
      list.querySelector<HTMLElement>('.taskchute-comment-text')!.click()
      expect(document.querySelector('.taskchute-comment-entry-modal')).toBeNull()
      list.querySelector<HTMLButtonElement>('.taskchute-comment-delete')!.click()
      expect(store.getComments({ instanceId: 'i-1', dateKey: DATE })).toEqual([])
    })
  })
})
