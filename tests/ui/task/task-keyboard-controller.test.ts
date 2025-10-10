import TaskKeyboardController from '../../../src/ui/task/TaskKeyboardController'
import type TaskSelectionController from '../../../src/ui/task/TaskSelectionController'

describe('TaskKeyboardController', () => {
  const createController = () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const events: Array<{
      target: Document | HTMLElement
      event: string
      handler: (event: Event) => void
    }> = []

    const selection = {
      handleKeyboardShortcut: jest.fn().mockResolvedValue(undefined),
      handleContainerClick: jest.fn(),
    } as unknown as TaskSelectionController

    const controller = new TaskKeyboardController({
      registerManagedDomEvent: (target, event, handler) => {
        events.push({ target, event, handler })
      },
      getContainer: () => container,
      selectionController: selection,
    })

    return { controller, container, events, selection }
  }

  afterEach(() => {
    document.body.innerHTML = ''
    jest.clearAllMocks()
  })

  test('initialize registers document keydown and container click handlers', () => {
    const { controller, events, container } = createController()

    controller.initialize()

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: document, event: 'keydown' }),
        expect.objectContaining({ target: container, event: 'click' }),
      ]),
    )
  })

  test('handleKeyDown delegates to selection controller when not ignored', async () => {
    const { controller, events, selection } = createController()
    controller.initialize()

    const keydown = events.find(({ target, event }) => target === document && event === 'keydown')
    expect(keydown).toBeDefined()

    keydown?.handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    await Promise.resolve()

    expect(selection.handleKeyboardShortcut).toHaveBeenCalled()
  })

  test('shouldIgnore returns true for focused input and modal overlay', () => {
    const { controller } = createController()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const ignoreInput = controller.shouldIgnore(new KeyboardEvent('keydown'))
    expect(ignoreInput).toBe(true)

    input.blur()
    document.body.removeChild(input)

    const overlay = document.createElement('div')
    overlay.classList.add('modal')
    document.body.appendChild(overlay)

    const ignoreModal = controller.shouldIgnore(new KeyboardEvent('keydown'))
    expect(ignoreModal).toBe(true)
  })
})
