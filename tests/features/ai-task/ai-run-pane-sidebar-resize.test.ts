import {
  AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY,
  AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY,
  AiRunPaneController,
} from '@/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '@/features/ai-task/ui/AiRunPaneController'
import type { AiRunRecord } from '@/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void

/** The pane only needs a manager that can be subscribed to. */
class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()

  onTerminalData(): () => void {
    return () => undefined
  }

  getRuns(): AiRunRecord[] {
    return []
  }

  getRun(): AiRunRecord | undefined {
    return undefined
  }

  getActiveRunForTask(): AiRunRecord | undefined {
    return undefined
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

describe('AI run pane sidebar resize', () => {
  let container: HTMLElement
  let controller: AiRunPaneController
  let stored: Map<string, unknown>
  let saveLocalStorage: jest.Mock

  const root = (): HTMLElement => container.querySelector('.ai-run-pane') as HTMLElement
  const sidebar = (): HTMLElement =>
    container.querySelector('.ai-run-pane__sidebar') as HTMLElement
  const handle = (): HTMLElement =>
    container.querySelector('.ai-run-pane__sidebar-resizer') as HTMLElement
  const toggle = (): HTMLElement =>
    container.querySelector('.ai-run-pane__sidebar-toggle') as HTMLElement
  const widthProperty = (): string => root().style.getPropertyValue('--tc-ai-sidebar-width')
  const isSidebarCollapsed = (): boolean => root().classList.contains('is-sidebar-collapsed')

  /** jsdom has no PointerEvent; a MouseEvent carrying pointerId is enough. */
  const pointer = (type: string, clientX: number): Event => {
    const event = new MouseEvent(type, { clientX, bubbles: true, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }

  /** Drag the splitter from x=500 (the sidebar's edge) through `xs`. */
  const drag = (...xs: number[]): void => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    for (const x of xs) handle().dispatchEvent(pointer('pointermove', x))
    handle().dispatchEvent(pointer('pointerup', xs[xs.length - 1] ?? 500))
  }

  const savedWith = (key: string): unknown[] =>
    saveLocalStorage.mock.calls
      .filter((call) => call[0] === key)
      .map((call) => call[1] as unknown)

  beforeEach(() => {
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    stored = new Map()
    saveLocalStorage = jest.fn((key: string, value: unknown) => {
      stored.set(key, value)
    })
    const host: AiRunPaneControllerHost = {
      tv: (_key: string, fallback: string) => fallback,
      manager: new FakeManager(),
      createTerminalAdapter: () => {
        throw new Error('sidebar resize tests never open a terminal adapter')
      },
      registerManagedDisposer: () => () => undefined,
      saveLocalStorage,
      loadLocalStorage: (key: string) => stored.get(key),
    }
    controller = new AiRunPaneController(host)
  })

  test('mounts the splitter between the sidebar and the content', () => {
    controller.mount(container)

    expect(sidebar().nextElementSibling).toBe(handle())
    expect(handle().nextElementSibling?.classList.contains('ai-run-pane__content')).toBe(true)
    expect(handle().getAttribute('aria-label')).toBe('Resize terminal sidebar')
  })

  test('a settled drag sets and stores the width; the moves before it store nothing', () => {
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 560))
    expect(widthProperty()).toBe('240px')
    expect(root().classList.contains('is-sidebar-sized')).toBe(true)
    expect(saveLocalStorage).not.toHaveBeenCalled()

    handle().dispatchEvent(pointer('pointerup', 580))
    expect(widthProperty()).toBe('260px')
    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([260])
    // Open before and after: the open/closed state is not written again.
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([])
  })

  test('past 35px the sidebar closes as its toggle does, and reopens at the width it had', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 300)
    controller.mount(container)

    // 300 -> 140 -> 30 (closed): previews only.
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 340))
    handle().dispatchEvent(pointer('pointermove', 230))
    expect(isSidebarCollapsed()).toBe(true)
    expect(saveLocalStorage).not.toHaveBeenCalled()

    handle().dispatchEvent(pointer('pointerup', 230))
    expect(isSidebarCollapsed()).toBe(true)
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([true])
    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([])
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    toggle().click()
    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('300px')
  })

  test('narrows smoothly to 35px, and past it closes', () => {
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 400))
    expect(widthProperty()).toBe('80px')
    handle().dispatchEvent(pointer('pointermove', 355))
    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('35px')
    handle().dispatchEvent(pointer('pointermove', 354))
    expect(isSidebarCollapsed()).toBe(true)
    handle().dispatchEvent(pointer('pointerup', 354))
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([true])
  })

  test('coming back within the same drag reopens the sidebar at the pointer', () => {
    controller.mount(container)

    drag(300, 400)
    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('80px')
    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([80])
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([])
  })

  test('crossing the snap point mid-drag changes the look, not the adopted state', () => {
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 300))
    // Closed on screen, with the toggle moved to the tab row...
    expect(isSidebarCollapsed()).toBe(true)
    expect(toggle().previousElementSibling?.classList.contains('ai-run-pane__collapse')).toBe(true)
    // ...but not adopted: the toggle still says open, and nothing is written.
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    handle().dispatchEvent(pointer('pointermove', 450))
    expect(isSidebarCollapsed()).toBe(false)
    expect(toggle().parentElement?.classList.contains('ai-run-pane__sidebar-toolbar')).toBe(true)
    expect(saveLocalStorage).not.toHaveBeenCalled()
    handle().dispatchEvent(pointer('pointerup', 450))
  })

  test('a narrow width is remembered for reopening like any other', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 40)
    controller.mount(container)
    expect(widthProperty()).toBe('40px')

    // Closed from 40px and opened again by its toggle: still 40px.
    drag(460)
    expect(isSidebarCollapsed()).toBe(true)
    toggle().click()
    expect(widthProperty()).toBe('40px')
  })

  test('dragging the closed sidebar edge opens it at the dragged width', () => {
    stored.set(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY, true)
    controller.mount(container)
    expect(isSidebarCollapsed()).toBe(true)

    handle().dispatchEvent(pointer('pointerdown', 0))
    handle().dispatchEvent(pointer('pointermove', 220))
    handle().dispatchEvent(pointer('pointerup', 220))

    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('220px')
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([false])
    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([220])
  })

  test('a cancelled drag puts the sidebar back as it was', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 260)
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 200))
    expect(isSidebarCollapsed()).toBe(true)
    handle().dispatchEvent(pointer('pointercancel', 200))

    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('260px')
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('restores the stored width on mount without writing it back', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 320)
    controller.mount(container)

    expect(widthProperty()).toBe('320px')
    expect(root().classList.contains('is-sidebar-sized')).toBe(true)
    expect(handle().getAttribute('aria-valuenow')).toBe('320')
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('clamps a stored width that is out of bounds or not a number', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 2000)
    controller.mount(container)
    expect(widthProperty()).toBe('480px')
    controller.unmount()

    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 'wide')
    controller.mount(container)
    expect(widthProperty()).toBe('')
    expect(root().classList.contains('is-sidebar-sized')).toBe(false)
  })

  test('a double click drops the user width back to the default and opens the sidebar', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 320)
    stored.set(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY, true)
    controller.mount(container)

    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(isSidebarCollapsed()).toBe(false)
    expect(widthProperty()).toBe('')
    expect(root().classList.contains('is-sidebar-sized')).toBe(false)
    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([null])
  })

  test('keyboard: arrows step the width, Enter opens and closes, all of it stored', () => {
    controller.mount(container)
    const key = (name: string) =>
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))

    key('ArrowRight')
    expect(widthProperty()).toBe('196px')
    key('Enter')
    expect(isSidebarCollapsed()).toBe(true)
    key('Enter')
    expect(isSidebarCollapsed()).toBe(false)

    expect(savedWith(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)).toEqual([196])
    expect(savedWith(AI_PANE_SIDEBAR_COLLAPSED_STORAGE_KEY)).toEqual([true, false])
  })

  test('unmount removes the splitter and forgets the width', () => {
    stored.set(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY, 320)
    controller.mount(container)
    controller.unmount()

    expect(container.querySelector('.ai-run-pane__sidebar-resizer')).toBeNull()

    stored.delete(AI_PANE_SIDEBAR_WIDTH_STORAGE_KEY)
    controller.mount(container)
    expect(widthProperty()).toBe('')
  })
})
