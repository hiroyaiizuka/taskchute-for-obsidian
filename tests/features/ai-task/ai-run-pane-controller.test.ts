import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunRecord, AiStreamEvent } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void

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

  getActiveRunForTask(taskPath: string): AiRunRecord | undefined {
    return this.records.find(
      (record) =>
        record.taskPath === taskPath &&
        (record.status === 'starting' ||
          record.status === 'running' ||
          record.status === 'stopping'),
    )
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(record: AiRunRecord): void {
    if (!this.records.includes(record)) {
      this.records.push(record)
    }
    for (const listener of this.listeners) {
      listener(record)
    }
  }
}

function createRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-1',
    taskPath: 'TASKS/ai-sample.md',
    taskName: 'AI sample',
    host: 'claude',
    mode: 'headless',
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

describe('AiRunPaneController', () => {
  let container: HTMLElement
  let manager: FakeManager
  let disposers: Array<() => void>
  let host: AiRunPaneControllerHost
  let controller: AiRunPaneController

  beforeEach(() => {
    // Event rendering coalesces into one requestAnimationFrame per burst;
    // modern fake timers mock rAF so flushEventFrame() drives it.
    jest.useFakeTimers()
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    disposers = []
    host = {
      tv: (_key, fallback, vars) => {
        if (!vars) return fallback
        return Object.entries(vars).reduce(
          (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
          fallback,
        )
      },
      manager,
      createTerminalAdapter: () => {
        throw new Error('headless pane tests never open a terminal adapter')
      },
      registerManagedDisposer: (cleanup) => {
        disposers.push(cleanup)
        return () => {
          const index = disposers.indexOf(cleanup)
          if (index >= 0) disposers.splice(index, 1)
        }
      },
    }
    controller = new AiRunPaneController(host)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const pane = (): HTMLElement | null => container.querySelector('.ai-run-pane')
  /** Fire the pending event-render animation frame (rAF ticks at ~16ms) */
  const flushEventFrame = (): void => {
    jest.advanceTimersByTime(20)
  }

  test('mounts hidden and subscribes to the manager', () => {
    controller.mount(container)

    expect(pane()).not.toBeNull()
    expect(pane()?.classList.contains('is-hidden')).toBe(true)
    expect(manager.listeners.size).toBe(1)
    expect(disposers.length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('.ai-run-pane__title')?.textContent).toBe(
      'AI runs',
    )
  })

  test('reveals the pane and adds a sidebar row when a run starts', () => {
    controller.mount(container)
    const run = createRun({ events: [{ kind: 'init', model: 'claude-test' }] })
    manager.emit(run)

    expect(pane()?.classList.contains('is-hidden')).toBe(false)
    const rows = container.querySelectorAll('.ai-run-pane__run')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('AI sample')
    expect(
      rows[0].querySelector('.ai-run-pane__run-dot--running'),
    ).not.toBeNull()

    const body = container.querySelector('.ai-run-pane__body.is-active')
    expect(body).not.toBeNull()
    expect(body?.querySelectorAll('.ai-run-pane__event')).toHaveLength(1)
  })

  test('appends events via textContent without parsing markup', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    run.events.push({ kind: 'assistant-text', text: 'Hello <b>world</b>' })
    manager.emit(run)
    flushEventFrame()

    const events = container.querySelectorAll('.ai-run-pane__event')
    expect(events).toHaveLength(1)
    expect(events[0].textContent).toBe('Hello <b>world</b>')
    expect(events[0].querySelector('b')).toBeNull()
    expect(
      events[0].classList.contains('ai-run-pane__event--assistant-text'),
    ).toBe(true)
  })

  test('appends only new events on repeated notifications', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    run.events.push({ kind: 'assistant-text', text: 'first' })
    manager.emit(run)
    flushEventFrame()
    run.events.push({ kind: 'stderr', text: 'warning' })
    manager.emit(run)
    flushEventFrame()

    const events = container.querySelectorAll('.ai-run-pane__event')
    expect(events).toHaveLength(2)
    expect(events[0].textContent).toBe('first')
    expect(events[1].textContent).toBe('warning')
    expect(events[1].classList.contains('ai-run-pane__event--stderr')).toBe(true)
  })

  test('rebuilds the event list when the elision marker changes', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    run.events.push({ kind: 'assistant-text', text: 'kept head' })
    manager.emit(run)
    flushEventFrame()

    // Simulate the manager's bounded buffer replacing middle events.
    run.events.splice(1, 0, { kind: 'elision', omittedCount: 3 } as AiStreamEvent)
    run.events.push({ kind: 'assistant-text', text: 'kept tail' })
    run.omittedEventCount = 3
    manager.emit(run)
    flushEventFrame()

    const events = container.querySelectorAll('.ai-run-pane__event')
    expect(events).toHaveLength(run.events.length)
    expect(
      container.querySelector('.ai-run-pane__event--elision')?.textContent,
    ).toContain('3')
  })

  test('coalesces a synchronous notification burst into one frame render', () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)

    const raf = jest.spyOn(window, 'requestAnimationFrame')
    run.events.push({ kind: 'assistant-text', text: 'one' })
    manager.emit(run)
    run.events.push({ kind: 'assistant-text', text: 'two' })
    manager.emit(run)
    run.events.push({ kind: 'assistant-text', text: 'three' })
    manager.emit(run)

    // The burst scheduled exactly ONE frame and nothing rendered before it.
    expect(raf).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('.ai-run-pane__event')).toHaveLength(0)

    flushEventFrame()
    const events = container.querySelectorAll('.ai-run-pane__event')
    expect(events).toHaveLength(3)
    expect(events[2].textContent).toBe('three')
    raf.mockRestore()
  })

  test('event frame uses and cancels through the root window when activeWindow changes', () => {
    const originalActiveWindow = activeWindow
    const rootRequestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(4242)
    const rootCancelFrame = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined)
    const popout = {
      requestAnimationFrame: jest.fn(() => 5252),
      cancelAnimationFrame: jest.fn(),
    } as unknown as Window
    const replacementPopout = {
      requestAnimationFrame: jest.fn(() => 6262),
      cancelAnimationFrame: jest.fn(),
    } as unknown as Window

    try {
      controller.mount(container)
      const run = createRun()
      manager.emit(run)
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        popout

      run.events.push({ kind: 'assistant-text', text: 'pending' })
      manager.emit(run)
      expect(rootRequestFrame).toHaveBeenCalledTimes(1)
      expect(popout.requestAnimationFrame).not.toHaveBeenCalled()

      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        replacementPopout
      controller.unmount()

      expect(rootCancelFrame).toHaveBeenCalledWith(4242)
      expect(popout.cancelAnimationFrame).not.toHaveBeenCalled()
      expect(replacementPopout.cancelAnimationFrame).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as typeof globalThis & { activeWindow: Window }).activeWindow =
        originalActiveWindow
      rootRequestFrame.mockRestore()
      rootCancelFrame.mockRestore()
    }
  })

  /** Simulated buffer that mirrors AiTaskManager.appendBoundedEvent shapes */
  function buildOverflowedRun(): AiRunRecord {
    const run = createRun()
    run.events = [
      { kind: 'assistant-text', text: 'head-0' },
      { kind: 'assistant-text', text: 'head-1' },
      { kind: 'elision', omittedCount: 1 },
      { kind: 'assistant-text', text: 'tail-0' },
      { kind: 'assistant-text', text: 'tail-1' },
      { kind: 'assistant-text', text: 'tail-2' },
    ]
    run.omittedEventCount = 1
    return run
  }

  /** One manager append after overflow: bump marker, drop oldest tail, push */
  function appendOverflowedEvent(run: AiRunRecord, text: string): void {
    const omitted = (run.omittedEventCount ?? 0) + 1
    run.events[2] = { kind: 'elision', omittedCount: omitted }
    run.events.splice(3, 1)
    run.events.push({ kind: 'assistant-text', text })
    run.omittedEventCount = omitted
  }

  test('after overflow a new event updates the marker in place and rotates only the tail', () => {
    controller.mount(container)
    const run = buildOverflowedRun()
    manager.emit(run)
    const body = container.querySelector('.ai-run-pane__body')
    if (!body) throw new Error('run body missing')
    const before = Array.from(body.children)
    expect(before).toHaveLength(6)
    expect(before[2].textContent).toBe('1 events omitted')

    appendOverflowedEvent(run, 'tail-3')
    manager.emit(run)
    flushEventFrame()

    const after = Array.from(body.children)
    expect(after).toHaveLength(6)
    // No rebuild: head nodes and the marker element keep their identity.
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(after[2].textContent).toBe('2 events omitted')
    // Oldest tail node pruned; the surviving tail keeps identity.
    expect(after[3]).toBe(before[4])
    expect(after[4]).toBe(before[5])
    expect(before).not.toContain(after[5])
    expect(after[5].textContent).toBe('tail-3')
  })

  test('a coalesced overflow burst prunes and appends the whole delta once', () => {
    controller.mount(container)
    const run = buildOverflowedRun()
    manager.emit(run)
    const body = container.querySelector('.ai-run-pane__body')
    if (!body) throw new Error('run body missing')
    const before = Array.from(body.children)

    appendOverflowedEvent(run, 'tail-3')
    manager.emit(run)
    appendOverflowedEvent(run, 'tail-4')
    manager.emit(run)
    flushEventFrame()

    const after = Array.from(body.children)
    expect(after).toHaveLength(6)
    expect(after[2]).toBe(before[2])
    expect(after[2].textContent).toBe('3 events omitted')
    // Two oldest tail nodes pruned; the survivor keeps identity.
    expect(after[3]).toBe(before[5])
    expect(after[4].textContent).toBe('tail-3')
    expect(after[5].textContent).toBe('tail-4')
  })

  test('switches bodies when sidebar rows are clicked and keeps one body per run', () => {
    controller.mount(container)
    const first = createRun({ id: 'run-a', taskName: 'Task A' })
    const second = createRun({ id: 'run-b', taskName: 'Task B' })
    manager.emit(first)
    manager.emit(second)

    const rows = container.querySelectorAll<HTMLElement>('.ai-run-pane__run')
    expect(rows).toHaveLength(2)
    const bodies = container.querySelectorAll('.ai-run-pane__body')
    expect(bodies).toHaveLength(2)

    controller.openRun('run-b')
    expect(
      container
        .querySelector('.ai-run-pane__body[data-run-id="run-b"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(
      container
        .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(false)

    rows[0].click()
    expect(
      container
        .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('tab × requests a stop while active and becomes a plain close once finished', () => {
    controller.mount(container)
    const run = createRun({ id: 'run-stop', status: 'running' })
    manager.emit(run)

    const closeButton = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__tab-close',
    )
    expect(closeButton).not.toBeNull()
    expect(closeButton?.getAttribute('aria-label')).toBe('Stop and close run')
    closeButton?.click()
    expect(manager.stopRun).toHaveBeenCalledWith('run-stop')
    // The view stays open until the manager's 'persisted' notification.
    expect(container.querySelectorAll('.ai-run-pane__run')).toHaveLength(1)

    run.status = 'succeeded'
    manager.emit(run)
    expect(
      container
        .querySelector('.ai-run-pane__tab-close')
        ?.getAttribute('aria-label'),
    ).toBe('Close run tab')
    expect(
      container.querySelector('.ai-run-pane__tab-dot--succeeded'),
    ).not.toBeNull()
  })

  test('collapse toggle collapses and expands the pane', () => {
    controller.mount(container)
    manager.emit(createRun())

    const toggle = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__collapse',
    )
    expect(toggle).not.toBeNull()

    toggle?.click()
    expect(pane()?.classList.contains('is-collapsed')).toBe(true)

    toggle?.click()
    expect(pane()?.classList.contains('is-collapsed')).toBe(false)

    controller.setCollapsed(true)
    expect(pane()?.classList.contains('is-collapsed')).toBe(true)
  })

  test('openRun reveals, expands, and selects the run', () => {
    controller.mount(container)
    const run = createRun({ id: 'run-open' })
    manager.emit(run)
    controller.setCollapsed(true)

    controller.openRun('run-open')

    expect(pane()?.classList.contains('is-hidden')).toBe(false)
    expect(pane()?.classList.contains('is-collapsed')).toBe(false)
    expect(
      container
        .querySelector('.ai-run-pane__run[data-run-id="run-open"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('renders runs that already exist at mount time', () => {
    manager.records.push(createRun({ id: 'pre-existing' }))
    controller.mount(container)

    expect(pane()?.classList.contains('is-hidden')).toBe(false)
    expect(container.querySelectorAll('.ai-run-pane__run')).toHaveLength(1)
  })

  test('unmount removes the manager listener and the pane DOM', () => {
    controller.mount(container)
    manager.emit(createRun())
    expect(manager.listeners.size).toBe(1)

    controller.unmount()

    expect(manager.listeners.size).toBe(0)
    expect(disposers).toHaveLength(0)
    expect(container.querySelector('.ai-run-pane')).toBeNull()
  })
})
