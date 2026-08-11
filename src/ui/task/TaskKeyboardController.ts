import TaskSelectionController from './TaskSelectionController'

type DomEventRegistrar = (
  target: Document | HTMLElement,
  event: string,
  handler: (event: Event) => void,
) => void

export interface TaskKeyboardControllerHost {
  registerManagedDomEvent: DomEventRegistrar
  getContainer: () => HTMLElement
  selectionController: TaskSelectionController
}

export default class TaskKeyboardController {
  constructor(private readonly host: TaskKeyboardControllerHost) {}

  initialize(): void {
    this.host.registerManagedDomEvent(
      this.host.getContainer(),
      'click',
      this.handleContainerClick,
    )
  }

  private handleContainerClick = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return
    this.host.selectionController.handleContainerClick(event)
  }
}
