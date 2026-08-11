import TaskViewLayout from '../../../src/ui/layout/TaskViewLayout'

function ensurePrototypeAugmentations(): void {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const element = document.createElement(tag)
      if (options.cls) {
        element.className = options.cls as string
      }
      if (options.text) {
        element.textContent = options.text as string
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          element.setAttribute(key, value)
        })
      }
      this.appendChild(element)
      return element
    }
  }
}

describe('TaskViewLayout', () => {
  beforeAll(() => {
    ensurePrototypeAugmentations()
  })

  it('renders layout and notifies host callbacks', () => {
    const renderHeader = jest.fn((container: HTMLElement) => {
      container.appendChild(document.createElement('span')).className = 'header-rendered'
    })
    const createNavigation = jest.fn((content: HTMLElement) => {
      content.appendChild(document.createElement('aside')).className = 'nav-rendered'
    })
    const registerTaskListElement = jest.fn()

    const layout = new TaskViewLayout({
      renderHeader,
      createNavigation,
      registerTaskListElement,
    })

    const root = document.createElement('div')

    const result = layout.render(root)

    expect(renderHeader).toHaveBeenCalledTimes(1)
    expect(createNavigation).toHaveBeenCalledTimes(1)
    expect(registerTaskListElement).toHaveBeenCalledTimes(1)
    expect(registerTaskListElement).toHaveBeenCalledWith(result.taskListElement)

    expect(result.topBarContainer.classList.contains('top-bar-container')).toBe(true)
    expect(result.mainContainer.classList.contains('taskchute-container')).toBe(true)
    expect(result.contentContainer.classList.contains('main-container')).toBe(true)
    expect(result.taskListContainer.classList.contains('task-list-container')).toBe(true)
    expect(result.taskListElement.classList.contains('task-list')).toBe(true)
    expect(result.taskListElement.parentElement).toBe(result.taskListContainer)
    expect(root.querySelector('.header-rendered')).not.toBeNull()
    expect(root.querySelector('.nav-rendered')).not.toBeNull()
  })
})
