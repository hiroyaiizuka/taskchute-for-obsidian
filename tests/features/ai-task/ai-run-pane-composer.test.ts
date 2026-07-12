/**
 * AI run pane composer:
 *   - enabled only when the selected run is finished AND has a session id
 *   - Enter (outside IME composition) or the send button dispatch a follow-up
 *     through manager.followUp and clear the input
 *   - failures surface as a Notice and never throw out of the handler
 */
import { Notice } from 'obsidian'
import { AiRunPaneController } from '../../../src/features/ai-task/ui/AiRunPaneController'
import type { AiRunPaneControllerHost } from '../../../src/features/ai-task/ui/AiRunPaneController'
import {
  AiRunAlreadyActiveError,
  AiSessionUnavailableError,
} from '../../../src/features/ai-task/services/AiTaskManager'
import { AiBinaryNotFoundError } from '../../../src/features/ai-task/services/BinaryLocator'
import type { AiRunRecord, AiRunStatus } from '../../../src/features/ai-task/types'

type ChangeListener = (record: AiRunRecord) => void

const ACTIVE_STATUSES: ReadonlySet<AiRunStatus> = new Set([
  'starting',
  'running',
  'stopping',
])

class FakeManager {
  readonly listeners = new Set<ChangeListener>()
  readonly records: AiRunRecord[] = []
  readonly stopRun = jest.fn()
  readonly sendTerminalInput = jest.fn()
  followUp: jest.Mock<Promise<AiRunRecord>, [string, string]> = jest.fn()

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
      (record) => record.taskPath === taskPath && ACTIVE_STATUSES.has(record.status),
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
    status: 'succeeded',
    startedAt: Date.now(),
    endedAt: Date.now(),
    sessionId: 'sess-1',
    events: [],
    ...overrides,
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function pressEnter(input: HTMLInputElement, options: { composing?: boolean } = {}): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  if (options.composing) {
    Object.defineProperty(event, 'isComposing', { value: true })
  }
  input.dispatchEvent(event)
}

describe('AiRunPaneController composer', () => {
  let container: HTMLElement
  let manager: FakeManager
  let controller: AiRunPaneController

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    document.body.replaceChildren()
    container = document.body.createDiv({ cls: 'ai-pane-container' })
    manager = new FakeManager()
    const host: AiRunPaneControllerHost = {
      tv: (_key, fallback, vars) => {
        if (!vars) return fallback
        return Object.entries(vars).reduce(
          (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
          fallback,
        )
      },
      manager,
      createTerminalAdapter: () => {
        throw new Error('composer tests never open a terminal adapter')
      },
      registerManagedDisposer: () => undefined,
    }
    controller = new AiRunPaneController(host)
  })

  const input = (): HTMLInputElement => {
    const element = container.querySelector<HTMLInputElement>(
      '.ai-run-pane__composer-input',
    )
    if (!element) throw new Error('composer input not rendered')
    return element
  }

  const sendButton = (): HTMLButtonElement => {
    const element = container.querySelector<HTMLButtonElement>(
      '.ai-run-pane__composer-send',
    )
    if (!element) throw new Error('composer send button not rendered')
    return element
  }

  test('mounts the composer disabled while no run is selected', () => {
    controller.mount(container)

    expect(container.querySelector('.ai-run-pane__composer')).not.toBeNull()
    expect(input().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
  })

  test('stays disabled while the selected run is active', () => {
    controller.mount(container)
    manager.emit(createRun({ status: 'running', endedAt: undefined }))

    expect(input().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(input().getAttribute('placeholder')).toContain('Running')
  })

  test('stays disabled when the run finished without a session id', () => {
    controller.mount(container)
    manager.emit(createRun({ sessionId: undefined }))

    expect(input().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(input().getAttribute('placeholder')).not.toContain('Running')
  })

  test('enables once the selected run is finished with a session id', () => {
    controller.mount(container)
    manager.emit(createRun())

    expect(input().disabled).toBe(false)
    expect(sendButton().disabled).toBe(false)
  })

  test('re-enables when a running run reaches a terminal status', () => {
    controller.mount(container)
    const run = createRun({ status: 'running', endedAt: undefined })
    manager.emit(run)
    expect(input().disabled).toBe(true)

    run.status = 'succeeded'
    run.endedAt = Date.now()
    manager.emit(run)

    expect(input().disabled).toBe(false)
  })

  test('tracks the selected tab, not just any run', () => {
    controller.mount(container)
    const finished = createRun({ id: 'run-done' })
    // A different task: an active run of the SAME task would disable the
    // composer for it (covered by its own test below).
    const active = createRun({
      id: 'run-live',
      taskPath: 'TASKS/other-task.md',
      status: 'running',
      endedAt: undefined,
    })
    manager.emit(finished)
    manager.emit(active)

    controller.openRun('run-live')
    expect(input().disabled).toBe(true)

    controller.openRun('run-done')
    expect(input().disabled).toBe(false)
  })

  test('Enter sends the follow-up and clears the input', async () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    manager.followUp.mockResolvedValueOnce(run)

    input().value = '  continue please  '
    pressEnter(input())
    await flushPromises()

    expect(manager.followUp).toHaveBeenCalledTimes(1)
    expect(manager.followUp).toHaveBeenCalledWith('run-1', 'continue please')
    expect(input().value).toBe('')
    expect(Notice as unknown as jest.Mock).not.toHaveBeenCalled()
  })

  test('Enter during IME composition does not send', () => {
    controller.mount(container)
    manager.emit(createRun())

    input().value = 'にほんご'
    pressEnter(input(), { composing: true })

    expect(manager.followUp).not.toHaveBeenCalled()
    expect(input().value).toBe('にほんご')
  })

  test('the send button sends the follow-up and clears the input', async () => {
    controller.mount(container)
    const run = createRun()
    manager.emit(run)
    manager.followUp.mockResolvedValueOnce(run)

    input().value = 'one more thing'
    sendButton().click()
    await flushPromises()

    expect(manager.followUp).toHaveBeenCalledWith('run-1', 'one more thing')
    expect(input().value).toBe('')
  })

  test('blank input is ignored', () => {
    controller.mount(container)
    manager.emit(createRun())

    input().value = '   '
    pressEnter(input())
    sendButton().click()

    expect(manager.followUp).not.toHaveBeenCalled()
  })

  test('Enter while disabled does not send', () => {
    controller.mount(container)
    manager.emit(createRun({ status: 'running', endedAt: undefined }))

    input().value = 'too early'
    pressEnter(input())

    expect(manager.followUp).not.toHaveBeenCalled()
  })

  test('stays disabled while another run of the same task is active', () => {
    controller.mount(container)
    const finished = createRun()
    manager.emit(finished)
    expect(input().disabled).toBe(false)

    const newer = createRun({ id: 'run-2', status: 'running', endedAt: undefined })
    manager.emit(newer)

    // run-1 stays selected, but its task already has an active run.
    expect(input().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)

    newer.status = 'succeeded'
    newer.endedAt = Date.now()
    manager.emit(newer)

    expect(input().disabled).toBe(false)
  })

  test('a follow-up rejected as already-active shows the localized notice, not the raw error', async () => {
    controller.mount(container)
    manager.emit(createRun())
    manager.followUp.mockRejectedValueOnce(
      new AiRunAlreadyActiveError('TASKS/ai-sample.md'),
    )

    input().value = 'continue'
    pressEnter(input())
    await flushPromises()

    const noticeMock = Notice as unknown as jest.Mock
    expect(noticeMock).toHaveBeenCalledTimes(1)
    const message = String(noticeMock.mock.calls[0][0])
    expect(message).toBe('An AI run is already in progress for this task.')
  })

  test('a follow-up rejected for a missing binary shows the localized binary notice', async () => {
    controller.mount(container)
    manager.emit(createRun())
    manager.followUp.mockRejectedValueOnce(new AiBinaryNotFoundError('claude'))

    input().value = 'continue'
    pressEnter(input())
    await flushPromises()

    const noticeMock = Notice as unknown as jest.Mock
    const message = String(noticeMock.mock.calls[0][0])
    expect(message).toBe(
      'AI CLI binary was not found: claude. Set the path in settings.',
    )
  })

  test('a follow-up rejected for a missing session shows the localized session notice', async () => {
    controller.mount(container)
    manager.emit(createRun())
    manager.followUp.mockRejectedValueOnce(new AiSessionUnavailableError('run-1'))

    input().value = 'continue'
    pressEnter(input())
    await flushPromises()

    const noticeMock = Notice as unknown as jest.Mock
    const message = String(noticeMock.mock.calls[0][0])
    expect(message).toBe('This run has no session to resume.')
  })

  test('a rejected follow-up shows a Notice and restores the text', async () => {
    controller.mount(container)
    manager.emit(createRun())
    manager.followUp.mockRejectedValueOnce(new Error('binary gone'))

    input().value = 'continue'
    pressEnter(input())
    await flushPromises()

    const noticeMock = Notice as unknown as jest.Mock
    expect(noticeMock).toHaveBeenCalledTimes(1)
    expect(String(noticeMock.mock.calls[0][0])).toContain('binary gone')
    expect(input().value).toBe('continue')
  })

  test('user-text events render with their own modifier class', () => {
    controller.mount(container)
    const run = createRun({
      events: [
        { kind: 'assistant-text', text: 'first answer' },
        { kind: 'user-text', text: 'follow-up prompt' },
      ],
    })
    manager.emit(run)

    const userEvent = container.querySelector('.ai-run-pane__event--user-text')
    expect(userEvent).not.toBeNull()
    expect(userEvent?.textContent).toContain('follow-up prompt')
  })
})
