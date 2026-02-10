import { createCommandRegistrar } from '../../src/commands/registerTaskCommands'
import type { CommandHost, ViewActions } from '../../src/types/Commands'
import type { Command } from 'obsidian'

describe('registerTaskCommands checkCallback', () => {
  const createMocks = () => {
    const registeredCommands: Record<string, Command> = {}

    const host: CommandHost = {
      manifest: { id: 'taskchute-plus' },
      addCommand: jest.fn((cmd: Command) => {
        registeredCommands[cmd.id] = cmd
        return cmd
      }),
      app: {
        commands: {
          removeCommand: jest.fn(),
        },
      } as unknown as CommandHost['app'],
      showSettingsModal: jest.fn(),
    }

    const view: ViewActions = {
      activateView: jest.fn().mockResolvedValue(undefined),
      isViewActive: jest.fn().mockReturnValue(true),
      triggerDuplicateSelectedTask: jest.fn().mockResolvedValue(undefined),
      triggerDeleteSelectedTask: jest.fn().mockResolvedValue(undefined),
      triggerResetSelectedTask: jest.fn().mockResolvedValue(undefined),
      triggerShowTodayTasks: jest.fn().mockResolvedValue(undefined),
      reorganizeIdleTasks: jest.fn(),
    }

    return { host, view, registeredCommands }
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function getCheckCallback(
    registeredCommands: Record<string, Command>,
    commandId: string,
  ): (checking: boolean) => boolean | void {
    const cmd = registeredCommands[commandId]
    expect(cmd).toBeDefined()
    expect(cmd.checkCallback).toBeDefined()
    return cmd.checkCallback!
  }

  describe.each([
    ['duplicate-selected-task', 'triggerDuplicateSelectedTask'],
    ['delete-selected-task', 'triggerDeleteSelectedTask'],
    ['reset-selected-task', 'triggerResetSelectedTask'],
  ])('%s', (commandId, triggerMethod) => {
    test('returns true when view is active and no input focused', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(true)
    })

    test('returns false when view is not active', () => {
      const { host, view, registeredCommands } = createMocks()
      ;(view.isViewActive as jest.Mock).mockReturnValue(false)
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns false when input element is focused', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns false when textarea is focused', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns false when modal is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const modal = document.createElement('div')
      modal.classList.add('modal')
      document.body.appendChild(modal)

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns true when command palette modal is open', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const paletteModal = document.createElement('div')
      paletteModal.classList.add('modal', 'mod-command-palette')
      const paletteInput = document.createElement('input')
      paletteInput.classList.add('prompt-input')
      paletteModal.appendChild(paletteInput)
      document.body.appendChild(paletteModal)
      paletteInput.focus()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(true)

      check(false)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).toHaveBeenCalled()
    })

    test('returns false when command palette and another modal are open', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const paletteModal = document.createElement('div')
      paletteModal.classList.add('modal', 'mod-command-palette')
      document.body.appendChild(paletteModal)

      const otherModal = document.createElement('div')
      otherModal.classList.add('modal')
      document.body.appendChild(otherModal)

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns false when command palette and task-modal-overlay are open', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const paletteModal = document.createElement('div')
      paletteModal.classList.add('modal', 'mod-command-palette')
      document.body.appendChild(paletteModal)

      const overlay = document.createElement('div')
      overlay.classList.add('task-modal-overlay')
      document.body.appendChild(overlay)

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('returns false when task-modal-overlay is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const overlay = document.createElement('div')
      overlay.classList.add('task-modal-overlay')
      document.body.appendChild(overlay)

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('executes action when checking is false and command is ready', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      check(false)

      expect((view as Record<string, jest.Mock>)[triggerMethod]).toHaveBeenCalled()
    })

    test('does not execute action when checking is false and command is not ready', () => {
      const { host, view, registeredCommands } = createMocks()
      ;(view.isViewActive as jest.Mock).mockReturnValue(false)
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      check(false)

      expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
    })
  })

  test('global commands use callback (not checkCallback)', () => {
    const { host, view, registeredCommands } = createMocks()
    const registrar = createCommandRegistrar(host, view)
    registrar.initialize()

    const globalIds = ['open-taskchute-view', 'taskchute-settings', 'show-today-tasks', 'reorganize-idle-tasks']
    for (const id of globalIds) {
      const cmd = registeredCommands[id]
      expect(cmd).toBeDefined()
      expect(cmd.callback).toBeDefined()
      expect(cmd.checkCallback).toBeUndefined()
    }
  })
})
