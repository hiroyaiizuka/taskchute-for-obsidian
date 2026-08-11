export interface TaskViewLayoutHost {
  renderHeader: (container: HTMLElement) => void
  createNavigation: (contentContainer: HTMLElement) => void
  registerTaskListElement: (element: HTMLElement) => void
}

export interface TaskViewLayoutRenderResult {
  topBarContainer: HTMLElement
  mainContainer: HTMLElement
  contentContainer: HTMLElement
  taskListContainer: HTMLElement
  taskListElement: HTMLElement
}

export default class TaskViewLayout {
  constructor(private readonly host: TaskViewLayoutHost) {}

  render(root: HTMLElement): TaskViewLayoutRenderResult {
    const topBarContainer = root.createDiv( { cls: 'top-bar-container' })
    this.host.renderHeader(topBarContainer)

    const mainContainer = root.createDiv( {
      cls: 'taskchute-container',
    })

    const contentContainer = mainContainer.createDiv( {
      cls: 'main-container',
    })

    this.host.createNavigation(contentContainer)

    const taskListContainer = contentContainer.createDiv( {
      cls: 'task-list-container',
    })

    const taskListElement = taskListContainer.createDiv( {
      cls: 'task-list',
    })

    this.host.registerTaskListElement(taskListElement)

    return {
      topBarContainer,
      mainContainer,
      contentContainer,
      taskListContainer,
      taskListElement,
    }
  }
}
