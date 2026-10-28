import type { App, Command } from 'obsidian'
import { registerAiTaskCommands } from '@/features/ai-task/registerAiTaskCommands'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'

jest.mock('@/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn(() => Promise.resolve(true)),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function register(app: App = {} as App) {
  const commands: Command[] = []
  const host: Parameters<typeof registerAiTaskCommands>[0] = {
    app,
    addCommand: (command) => {
      commands.push(command)
      return command
    },
  }
  registerAiTaskCommands(host)
  const command = commands.find((candidate) => candidate.id === 'restart-ai-terminals')
  if (!command?.checkCallback) throw new Error('restart-ai-terminals is not registered')
  return { host, check: command.checkCallback }
}

function manager(live: number, canRestart = true) {
  return {
    canRestartTerminals: jest.fn(() => canRestart),
    countLiveTerminals: jest.fn(() => live),
    restartTerminals: jest.fn(() => Promise.resolve()),
  }
}

describe('Restart AI terminals command (LEV-405)', () => {
  beforeEach(() => {
    jest.mocked(showConfirmModal).mockClear()
  })

  test('is listed only while terminals run in a broker', () => {
    const { host, check } = register()
    expect(check(true)).toBe(false)

    host.aiTaskManager = manager(0, false)
    expect(check(true)).toBe(false)

    host.aiTaskManager = manager(0)
    expect(check(true)).toBe(true)
  })

  test('a manager kept from before a plugin update, without these methods, just hides it', () => {
    const { host, check } = register()
    host.aiTaskManager = {}
    expect(() => check(true)).not.toThrow()
    expect(check(true)).toBe(false)
  })

  test('asks before ending running terminals, then restarts', async () => {
    const { host, check } = register()
    const current = manager(3)
    host.aiTaskManager = current

    check(false)
    await flush()

    expect(showConfirmModal).toHaveBeenCalledTimes(1)
    expect(current.restartTerminals).toHaveBeenCalledTimes(1)
  })

  /** An app whose open TaskChute view stops the AI tasks' timers. */
  function appWithTaskChuteView(order: string[]) {
    const view = {
      stopAiTaskTimersForTerminalRestart: jest.fn(() => {
        order.push('timers')
        return Promise.resolve()
      }),
    }
    const app = {
      workspace: { getLeavesOfType: jest.fn((type: string) => (type === 'taskchute-view' ? [{ view }] : [])) },
    } as unknown as App
    return { app, view }
  }

  test('with a TaskChute view open, says how many AI tasks stop, and stops their timers before the terminals', async () => {
    const order: string[] = []
    const { app, view } = appWithTaskChuteView(order)
    const { host, check } = register(app)
    const current = { ...manager(3), countLiveTerminalTasks: jest.fn(() => 2) }
    current.restartTerminals.mockImplementation(() => {
      order.push('terminals')
      return Promise.resolve()
    })
    host.aiTaskManager = current

    check(false)
    await flush()

    const message = jest.mocked(showConfirmModal).mock.calls[0]?.[1].message ?? ''
    expect(message).toContain('3 running terminal(s) will end')
    expect(message).toContain('2 running AI task(s)')
    expect(message).toContain('marked done')
    expect(view.stopAiTaskTimersForTerminalRestart).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['timers', 'terminals'])
  })

  test('without a TaskChute view, does not promise that the AI tasks are marked done', async () => {
    const { host, check } = register()
    host.aiTaskManager = { ...manager(3), countLiveTerminalTasks: jest.fn(() => 2) }

    check(false)
    await flush()

    const message = jest.mocked(showConfirmModal).mock.calls[0]?.[1].message ?? ''
    expect(message).toContain('3 running terminal(s) will end')
    expect(message).not.toContain('AI task')
  })

  test('without AI tasks among them, the message is only about the terminals', async () => {
    const { app } = appWithTaskChuteView([])
    const { host, check } = register(app)
    host.aiTaskManager = { ...manager(1), countLiveTerminalTasks: jest.fn(() => 0) }

    check(false)
    await flush()

    const message = jest.mocked(showConfirmModal).mock.calls[0]?.[1].message ?? ''
    expect(message).toContain('1 running terminal(s) will end')
    expect(message).not.toContain('AI task')
  })

  test('uses the manager that is current when it runs, not the one at startup', async () => {
    const { host, check } = register()
    host.aiTaskManager = manager(0)
    const replaced = manager(0)
    host.aiTaskManager = replaced

    check(false)
    await flush()

    expect(showConfirmModal).not.toHaveBeenCalled()
    expect(replaced.restartTerminals).toHaveBeenCalledTimes(1)
  })
})
