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
    test('checking=true: returns true when view is active', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(true)
    })

    test('checking=true: returns false when view is not active', () => {
      const { host, view, registeredCommands } = createMocks()
      ;(view.isViewActive as jest.Mock).mockReturnValue(false)
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(false)
    })

    test('checking=true: returns true even when task-modal-overlay is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const overlay = document.createElement('div')
      overlay.classList.add('task-modal-overlay')
      document.body.appendChild(overlay)

      const check = getCheckCallback(registeredCommands, commandId)
      expect(check(true)).toBe(true)
    })

    test('checking=false: executes action when view is active and no blocking modal', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(true)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).toHaveBeenCalled()
    })

    test('checking=false: does not execute when view is not active', () => {
      const { host, view, registeredCommands } = createMocks()
      ;(view.isViewActive as jest.Mock).mockReturnValue(false)
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(false)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
    })

    test('checking=false: does not execute when input element is focused', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(false)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
    })

    test('checking=false: does not execute when contenteditable element is focused', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const editor = document.createElement('div')
      Object.defineProperty(editor, 'isContentEditable', { value: true, configurable: true })
      const activeElementSpy = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(editor)

      try {
        const check = getCheckCallback(registeredCommands, commandId)
        const result = check(false)

        expect(result).toBe(false)
        expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
      } finally {
        activeElementSpy.mockRestore()
      }
    })

    test('checking=false: does not execute when non-command-palette modal is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const modal = document.createElement('div')
      modal.classList.add('modal')
      document.body.appendChild(modal)

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(false)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
    })

    test('checking=false: executes when only command palette modal is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const modal = document.createElement('div')
      modal.classList.add('modal', 'mod-command-palette')
      document.body.appendChild(modal)

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(true)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).toHaveBeenCalled()
    })

    test('checking=false: does not execute when command palette and another modal are present', () => {
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
      const result = check(false)

      expect(result).toBe(false)
      expect((view as Record<string, jest.Mock>)[triggerMethod]).not.toHaveBeenCalled()
    })

    test('checking=false: does not execute when task-modal-overlay is present', () => {
      const { host, view, registeredCommands } = createMocks()
      const registrar = createCommandRegistrar(host, view)
      registrar.initialize()

      const overlay = document.createElement('div')
      overlay.classList.add('task-modal-overlay')
      document.body.appendChild(overlay)

      const check = getCheckCallback(registeredCommands, commandId)
      const result = check(false)

      expect(result).toBe(false)
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
