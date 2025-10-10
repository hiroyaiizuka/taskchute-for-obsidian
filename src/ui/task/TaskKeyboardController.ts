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
    this.host.registerManagedDomEvent(document, 'keydown', this.handleKeyDown)
    this.host.registerManagedDomEvent(
      this.host.getContainer(),
      'click',
      this.handleContainerClick,
    )
  }

  shouldIgnore(event: KeyboardEvent): boolean {
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable)
    ) {
      return true
    }

    if (document.querySelector('.modal') || document.querySelector('.task-modal-overlay')) {
      return true
    }

    return false
  }

  private handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return
    if (this.shouldIgnore(event)) return
    void this.host.selectionController.handleKeyboardShortcut(event)
  }

  private handleContainerClick = (event: Event): void => {
    if (!(event instanceof MouseEvent)) return
    this.host.selectionController.handleContainerClick(event)
  }
}
