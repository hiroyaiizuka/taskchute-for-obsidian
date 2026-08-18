import TaskViewLayout from '../../../src/ui/layout/TaskViewLayout'

describe('TaskViewLayout responsive container boundary', () => {
  test('marks the whole view as the header container-query boundary', () => {
    const root = document.createElement('div')
    const layout = new TaskViewLayout({
      renderHeader: jest.fn(),
      createNavigation: jest.fn(),
      registerTaskListElement: jest.fn(),
    })

    layout.render(root)

    expect(root.classList.contains('taskchute-view-root')).toBe(true)
  })
})
