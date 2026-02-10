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

  test('initialize registers container click handler only', () => {
    const { controller, events, container } = createController()

    controller.initialize()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({ target: container, event: 'click' }),
    )
  })

  test('container click delegates to selection controller', () => {
    const { controller, events, selection } = createController()
    controller.initialize()

    const click = events.find(({ event }) => event === 'click')
    expect(click).toBeDefined()

    const mouseEvent = new MouseEvent('click')
    click?.handler(mouseEvent)

    expect(selection.handleContainerClick).toHaveBeenCalledWith(mouseEvent)
  })

  test('container click ignores non-MouseEvent', () => {
    const { controller, events, selection } = createController()
    controller.initialize()

    const click = events.find(({ event }) => event === 'click')
    click?.handler(new Event('click'))

    expect(selection.handleContainerClick).not.toHaveBeenCalled()
  })
})
