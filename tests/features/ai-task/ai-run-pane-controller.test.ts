import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunRecord, AiStreamEvent } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void

class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly stopRun = jest.fn()

  getRuns(): AiRunRecord[] {
    return [...this.records]
  }

  getRun(runId: string): AiRunRecord | undefined {
    return this.records.find((record) => record.id === runId)
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
      registerManagedDisposer: (cleanup) => {
        disposers.push(cleanup)
      },
    }
    controller = new AiRunPaneController(host)
  })

  const pane = (): HTMLElement | null => container.querySelector('.ai-run-pane')

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

  test('reveals the pane and adds a tab when a run starts', () => {
    controller.mount(container)
    const run = createRun({ events: [{ kind: 'init', model: 'claude-test' }] })
    manager.emit(run)

    expect(pane()?.classList.contains('is-hidden')).toBe(false)
    const tabs = container.querySelectorAll('.ai-run-pane__tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].textContent).toContain('AI sample')
    expect(
      tabs[0].querySelector('.ai-run-pane__tab-dot--running'),
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
    run.events.push({ kind: 'stderr', text: 'warning' })
    manager.emit(run)

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

    // Simulate the manager's bounded buffer replacing middle events.
    run.events.splice(1, 0, { kind: 'elision', omittedCount: 3 } as AiStreamEvent)
    run.events.push({ kind: 'assistant-text', text: 'kept tail' })
    run.omittedEventCount = 3
    manager.emit(run)

    const events = container.querySelectorAll('.ai-run-pane__event')
    expect(events).toHaveLength(run.events.length)
    expect(
      container.querySelector('.ai-run-pane__event--elision')?.textContent,
    ).toContain('3')
  })

  test('switches bodies when tabs are clicked and keeps one body per run', () => {
    controller.mount(container)
    const first = createRun({ id: 'run-a', taskName: 'Task A' })
    const second = createRun({ id: 'run-b', taskName: 'Task B' })
    manager.emit(first)
    manager.emit(second)

    const tabs = container.querySelectorAll<HTMLElement>('.ai-run-pane__tab')
    expect(tabs).toHaveLength(2)
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

    tabs[0].click()
    expect(
      container
        .querySelector('.ai-run-pane__body[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
    expect(
      container
        .querySelector('.ai-run-pane__tab[data-run-id="run-a"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('tab stop control stops the run while active and disappears once terminal', () => {
    controller.mount(container)
    const run = createRun({ id: 'run-stop', status: 'running' })
    manager.emit(run)

    const stopButton = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__tab-stop',
    )
    expect(stopButton).not.toBeNull()
    stopButton?.click()
    expect(manager.stopRun).toHaveBeenCalledWith('run-stop')

    run.status = 'succeeded'
    manager.emit(run)
    expect(container.querySelector('.ai-run-pane__tab-stop')).toBeNull()
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
        .querySelector('.ai-run-pane__tab[data-run-id="run-open"]')
        ?.classList.contains('is-active'),
    ).toBe(true)
  })

  test('renders runs that already exist at mount time', () => {
    manager.records.push(createRun({ id: 'pre-existing' }))
    controller.mount(container)

    expect(pane()?.classList.contains('is-hidden')).toBe(false)
    expect(container.querySelectorAll('.ai-run-pane__tab')).toHaveLength(1)
  })

  test('unmount removes the manager listener and the pane DOM', () => {
    controller.mount(container)
    manager.emit(createRun())
    expect(manager.listeners.size).toBe(1)

    controller.unmount()

    expect(manager.listeners.size).toBe(0)
    expect(container.querySelector('.ai-run-pane')).toBeNull()
  })
})
