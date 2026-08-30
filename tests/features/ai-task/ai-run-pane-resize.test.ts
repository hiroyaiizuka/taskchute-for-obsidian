import {
  AI_PANE_EXPANDED_STORAGE_KEY,
  AI_PANE_HEIGHT_RATIO_STORAGE_KEY,
  AiRunPaneController,
} from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunRecord } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void

/** The pane only needs a manager that can be subscribed to and emit a run. */
class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly stopRun = jest.fn()
  readonly followUp = jest.fn(() => Promise.resolve())
  readonly sendTerminalInput = jest.fn()

  onTerminalData(): () => void {
    return () => undefined
  }

  getRuns(): AiRunRecord[] {
    return [...this.records]
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.records.find((record) => record.id === runId)
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

  emit(record: AiRunRecord): void {
    if (!this.records.includes(record)) this.records.push(record)
    for (const listener of this.listeners) listener(record)
  }
}

const VIEW_HEIGHT = 1000
const START_PANE_HEIGHT = 400

describe('AI run pane drag resize', () => {
  let container: HTMLElement
  let manager: FakeManager
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController
  let stored: Map<string, unknown>
  let saveLocalStorage: jest.Mock
  let paneHeight: number

  const handle = (): HTMLElement =>
    container.querySelector('.ai-pane-resizer') as HTMLElement

  /** jsdom has no PointerEvent; a MouseEvent carrying pointerId is enough. */
  const pointer = (type: string, clientY: number): Event => {
    const event = new MouseEvent(type, { clientY, bubbles: true, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }

  const drag = (deltaY: number): void => {
    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 500 + deltaY))
    handle().dispatchEvent(pointer('pointerup', 500 + deltaY))
  }

  const heightProperty = (): string =>
    container.style.getPropertyValue('--tc-ai-pane-height')

  beforeEach(() => {
    jest.useFakeTimers()
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    paneHeight = START_PANE_HEIGHT

    // jsdom reports zero for every box, so the two measurements the resizer
    // and computeTerminalSize rely on are stubbed explicitly.
    Object.defineProperty(document.body, 'clientHeight', {
      configurable: true,
      value: VIEW_HEIGHT,
    })
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 800,
    })
    container.getBoundingClientRect = () =>
      ({ height: paneHeight }) as DOMRect

    manager = new FakeManager()
    stored = new Map()
    saveLocalStorage = jest.fn((key: string, value: unknown) => {
      stored.set(key, value)
    })
    host = {
      tv: (_key: string, fallback: string) => fallback,
      manager,
      createTerminalAdapter: () => {
        throw new Error('resize tests never open a terminal adapter')
      },
      registerManagedDisposer: () => () => undefined,
      saveLocalStorage,
      loadLocalStorage: (key: string) => stored.get(key),
    }
    controller = new AiRunPaneController(host)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('mounts the splitter as the container first child', () => {
    controller.mount(container)

    expect(container.firstElementChild).toBe(handle())
    expect(handle().getAttribute('role')).toBe('separator')
    expect(handle().getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle().getAttribute('tabindex')).toBe('0')
    expect(handle().getAttribute('aria-label')).toBe('Resize AI run pane')
  })

  test('dragging upward grows the pane and marks it as user-sized', () => {
    controller.mount(container)

    drag(-100)

    expect(container.classList.contains('ai-pane-container--sized')).toBe(true)
    expect(heightProperty()).toBe('50.00%')
  })

  test('dragging downward shrinks the pane', () => {
    controller.mount(container)

    drag(100)

    expect(heightProperty()).toBe('30.00%')
  })

  test('clamps to the minimum pane height and the maximum view share', () => {
    controller.mount(container)

    drag(350)
    expect(heightProperty()).toBe('12.00%')

    paneHeight = START_PANE_HEIGHT
    drag(-700)
    expect(heightProperty()).toBe('90.00%')
  })

  test('persists the height once the gesture settles, not during the drag', () => {
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 450))
    expect(saveLocalStorage).not.toHaveBeenCalled()

    handle().dispatchEvent(pointer('pointerup', 450))
    expect(saveLocalStorage).toHaveBeenCalledWith(
      AI_PANE_HEIGHT_RATIO_STORAGE_KEY,
      0.45,
    )
  })

  test('a cancelled gesture leaves the previous stored height alone', () => {
    controller.mount(container)

    handle().dispatchEvent(pointer('pointerdown', 500))
    handle().dispatchEvent(pointer('pointermove', 450))
    handle().dispatchEvent(pointer('pointercancel', 450))

    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('restores the stored height on mount without writing it back', () => {
    stored.set(AI_PANE_HEIGHT_RATIO_STORAGE_KEY, 0.62)

    controller.mount(container)

    expect(container.classList.contains('ai-pane-container--sized')).toBe(true)
    expect(heightProperty()).toBe('62.00%')
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('dragging out of the expanded mode hands control back to the splitter', () => {
    stored.set(AI_PANE_EXPANDED_STORAGE_KEY, true)
    controller.mount(container)
    manager.emit({
      id: 'run-1',
      taskPath: 'TASKS/ai-sample.md',
      taskName: 'AI sample',
      host: 'claude',
      mode: 'headless',
      status: 'running',
      startedAt: Date.now(),
      events: [],
    })
    expect(container.classList.contains('ai-pane-container--expanded')).toBe(true)

    drag(-100)

    expect(container.classList.contains('ai-pane-container--expanded')).toBe(
      false,
    )
    expect(saveLocalStorage).toHaveBeenCalledWith(
      AI_PANE_EXPANDED_STORAGE_KEY,
      false,
    )
    expect(heightProperty()).toBe('50.00%')
  })

  test('arrow keys nudge the height and Home restores the default', () => {
    controller.mount(container)

    handle().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    )
    expect(heightProperty()).toBe('41.60%')

    handle().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    )
    expect(container.classList.contains('ai-pane-container--sized')).toBe(false)
    expect(heightProperty()).toBe('')
    expect(saveLocalStorage).toHaveBeenLastCalledWith(
      AI_PANE_HEIGHT_RATIO_STORAGE_KEY,
      null,
    )
  })

  test('a double click on the handle drops back to the default height', () => {
    controller.mount(container)
    drag(-100)
    expect(container.classList.contains('ai-pane-container--sized')).toBe(true)

    handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(container.classList.contains('ai-pane-container--sized')).toBe(false)
  })

  test('the collapsed chrome class follows the header toggle', () => {
    controller.mount(container)
    manager.emit({
      id: 'run-1',
      taskPath: 'TASKS/ai-sample.md',
      taskName: 'AI sample',
      host: 'claude',
      mode: 'headless',
      status: 'running',
      startedAt: Date.now(),
      events: [],
    })
    expect(container.classList.contains('ai-pane-container--collapsed')).toBe(
      false,
    )

    controller.setCollapsed(true)
    expect(container.classList.contains('ai-pane-container--collapsed')).toBe(
      true,
    )

    controller.setCollapsed(false)
    expect(container.classList.contains('ai-pane-container--collapsed')).toBe(
      false,
    )
  })

  test('the PTY grid follows the dragged height', () => {
    controller.mount(container)
    const before = controller.computeTerminalSize()

    drag(-300)
    const after = controller.computeTerminalSize()

    expect(after.rows).toBeGreaterThan(before.rows)
    expect(after.cols).toBe(before.cols)
  })

  test('unmount removes the handle and the height it applied', () => {
    controller.mount(container)
    drag(-100)

    controller.unmount()

    expect(container.querySelector('.ai-pane-resizer')).toBeNull()
    expect(container.classList.contains('ai-pane-container--sized')).toBe(false)
    expect(heightProperty()).toBe('')
  })
})
