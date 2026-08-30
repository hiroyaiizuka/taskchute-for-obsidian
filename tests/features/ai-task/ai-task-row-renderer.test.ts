import { setIcon } from 'obsidian'
import { AiTaskRowRenderer } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiTaskRowRendererHost } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { TaskInstance } from '../../../src/types'

function createInstance(
  frontmatter: Record<string, unknown> | undefined = { ai_task: true },
): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: frontmatter ?? {},
      path: 'TASKS/ai-sample.md',
      name: 'AI sample',
      isRoutine: false,
    },
    instanceId: 'instance-1',
    state: 'idle',
    slotKey: 'none',
  }
}

function createHost(
  overrides: Partial<AiTaskRowRendererHost> = {},
): AiTaskRowRendererHost {
  return {
    tv: (_key, fallback) => fallback,
    isAiTaskFeatureEnabled: () => true,
    editAiTask: jest.fn(),
    ...overrides,
  }
}

describe('AiTaskRowRenderer', () => {
  let taskItem: HTMLElement
  let nameContainer: HTMLElement

  beforeEach(() => {
    document.body.replaceChildren()
    ;(setIcon as jest.MockedFunction<typeof setIcon>).mockClear()
    taskItem = document.body.createDiv({ cls: 'task-item' })
    nameContainer = taskItem.createSpan({ cls: 'task-name-container' })
  })

  test('renders nothing when the feature is disabled', () => {
    const host = createHost({ isAiTaskFeatureEnabled: () => false })
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    expect(nameContainer.children).toHaveLength(0)
    expect(taskItem.querySelector('.ai-task-edit-button')).toBeNull()
  })

  test('renders nothing when the task has no ai_task frontmatter', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(nameContainer, createInstance({}))

    expect(nameContainer.children).toHaveLength(0)
  })

  test('renders nothing when ai_task is not strictly true', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(
      nameContainer,
      createInstance({ ai_task: 'yes' }),
    )

    expect(nameContainer.children).toHaveLength(0)
  })

  test('renders an edit button with aria-label for a configured idle task', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    const button = taskItem.querySelector<HTMLButtonElement>('.ai-task-edit-button')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Edit AI task')
    expect(taskItem.querySelector('.ai-task-status-chip')).toBeNull()
  })

  test('renders a link-2 status icon for an enabled valid Obsidian-linked AI task', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(
      nameContainer,
      createInstance({
        ai_task: true,
        obsidian_sync: {
          enabled: true,
          taskTitle: 'CEO review',
          matchType: 'exact',
        },
      }),
    )

    const icon = taskItem.querySelector<HTMLElement>(
      '.ai-task-obsidian-link-icon',
    )
    expect(icon).not.toBeNull()
    expect(icon?.getAttribute('data-icon')).toBe('link-2')
    expect(icon?.getAttribute('aria-label')).toBe('Linked with Obsidian')
    expect(setIcon).toHaveBeenCalledWith(icon, 'link-2')
  })

  test.each([
    { enabled: false, taskTitle: 'CEO review', matchType: 'exact' },
    { enabled: true, taskTitle: '', matchType: 'exact' },
    { enabled: true, taskTitle: 'CEO review', matchType: 'invalid' },
  ])('omits the link status icon for an inactive config: %#', (obsidianSync) => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(
      nameContainer,
      createInstance({ ai_task: true, obsidian_sync: obsidianSync }),
    )

    expect(taskItem.querySelector('.ai-task-obsidian-link-icon')).toBeNull()
    expect(setIcon).not.toHaveBeenCalled()
  })

  test('appends the controls inside the given container, never as a direct child of the task item', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    const controls = taskItem.querySelector('.ai-task-controls')
    expect(controls).not.toBeNull()
    // The .task-item grid has a fixed column template; adding a direct child
    // would shift every subsequent column. Controls must live inside the
    // task name container instead.
    expect(controls?.parentElement).toBe(nameContainer)
    expect(
      Array.from(taskItem.children).some((el) =>
        el.classList.contains('ai-task-controls'),
      ),
    ).toBe(false)
  })

  test('robot click opens the AI task editor and stops propagation', () => {
    const host = createHost()
    const inst = createInstance()
    const parentClick = jest.fn()
    document.body.addEventListener('click', parentClick)

    new AiTaskRowRenderer(host).render(nameContainer, inst)
    const button = taskItem.querySelector<HTMLButtonElement>('.ai-task-edit-button')
    button?.click()

    expect(host.editAiTask).toHaveBeenCalledWith(inst)
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)
  })

  test('keeps the plain robot edit button and omits redundant status for a running task', () => {
    const host = createHost()
    const inst = createInstance()
    inst.state = 'running'
    new AiTaskRowRenderer(host).render(nameContainer, inst)

    const button = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-edit-button',
    )
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('🤖')
    expect(button?.getAttribute('aria-label')).toBe('Edit AI task')
    expect(taskItem.querySelector('.ai-task-status-chip')).toBeNull()
  })

  test('running-task robot still opens its editor and stops propagation', () => {
    const host = createHost()
    const inst = createInstance()
    inst.state = 'running'
    const parentClick = jest.fn()
    document.body.addEventListener('click', parentClick)

    new AiTaskRowRenderer(host).render(nameContainer, inst)
    const button = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-edit-button',
    )
    button?.click()

    expect(host.editAiTask).toHaveBeenCalledWith(inst)
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)
  })
})
