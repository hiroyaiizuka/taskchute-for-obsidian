export interface TaskViewLayoutHost {
  renderHeader: (container: HTMLElement) => void
  createNavigation: (contentContainer: HTMLElement) => void
  registerTaskListElement: (element: HTMLElement) => void
}

export interface TaskViewLayoutRenderResult {
  topBarContainer: HTMLElement
  mainContainer: HTMLElement
  contentContainer: HTMLElement
  /**
   * Holds the task list without scrolling with it, so what floats over the
   * list (the day's comments button and window) stays put.
   */
  taskListArea: HTMLElement
  taskListContainer: HTMLElement
  taskListElement: HTMLElement
  aiPaneContainer: HTMLElement
}

export default class TaskViewLayout {
  constructor(private readonly host: TaskViewLayoutHost) {}

  render(root: HTMLElement): TaskViewLayoutRenderResult {
    // Container-query boundary for the whole TaskChute leaf. Obsidian can
    // split a desktop leaf without changing the browser viewport, so header
    // responsiveness must follow this element's width rather than @media.
    root.classList.add('taskchute-view-root')
    const topBarContainer = root.createDiv( { cls: 'top-bar-container' })
    this.host.renderHeader(topBarContainer)

    const mainContainer = root.createDiv( {
      cls: 'taskchute-container',
    })

    const contentContainer = mainContainer.createDiv( {
      cls: 'main-container',
    })

    this.host.createNavigation(contentContainer)

    const taskListArea = contentContainer.createDiv({
      cls: 'taskchute-list-area',
    })

    const taskListContainer = taskListArea.createDiv( {
      cls: 'task-list-container',
    })

    const taskListElement = taskListContainer.createDiv( {
      cls: 'task-list',
    })

    this.host.registerTaskListElement(taskListElement)

    // Always present; stays empty (and invisible) while the AI Task feature
    // is disabled. AiRunPaneController mounts into it when enabled.
    const aiPaneContainer = contentContainer.createDiv( {
      cls: 'ai-pane-container',
    })

    return {
      topBarContainer,
      mainContainer,
      contentContainer,
      taskListArea,
      taskListContainer,
      taskListElement,
      aiPaneContainer,
    }
  }
}
