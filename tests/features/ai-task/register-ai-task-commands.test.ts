import type { App, Command } from 'obsidian'
import { registerAiTaskCommands } from '@/features/ai-task/registerAiTaskCommands'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'

jest.mock('@/ui/modals/ConfirmModal', () => ({
  showConfirmModal: jest.fn(() => Promise.resolve(true)),
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function register() {
  const commands: Command[] = []
  const host: Parameters<typeof registerAiTaskCommands>[0] = {
    app: {} as App,
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
