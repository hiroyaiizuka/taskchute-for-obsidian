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
  } as TaskInstance
}

function createHost(
  overrides: Partial<AiTaskRowRendererHost> = {},
): AiTaskRowRendererHost {
  return {
    tv: (_key, fallback) => fallback,
    isAiTaskFeatureEnabled: () => true,
    startAiRun: jest.fn(),
    ...overrides,
  }
}

describe('AiTaskRowRenderer', () => {
  let taskItem: HTMLElement
  let nameContainer: HTMLElement

  beforeEach(() => {
    document.body.replaceChildren()
    taskItem = document.body.createDiv({ cls: 'task-item' })
    nameContainer = taskItem.createSpan({ cls: 'task-name-container' })
  })

  test('renders nothing when the feature is disabled', () => {
    const host = createHost({ isAiTaskFeatureEnabled: () => false })
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    expect(nameContainer.children).toHaveLength(0)
    expect(taskItem.querySelector('.ai-task-run-button')).toBeNull()
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

  test('renders a run button with aria-label for a configured idle task', () => {
    const host = createHost()
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    const button = taskItem.querySelector<HTMLButtonElement>('.ai-task-run-button')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('Run AI task')
    expect(taskItem.querySelector('.ai-task-status-chip')).toBeNull()
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

  test('run button click starts the run and stops propagation', () => {
    const host = createHost()
    const inst = createInstance()
    const parentClick = jest.fn()
    document.body.addEventListener('click', parentClick)

    new AiTaskRowRenderer(host).render(nameContainer, inst)
    const button = taskItem.querySelector<HTMLButtonElement>('.ai-task-run-button')
    button?.click()

    expect(host.startAiRun).toHaveBeenCalledWith(inst)
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)
  })

  test('keeps the plain robot button and omits redundant status for a running task', () => {
    const host = createHost()
    const inst = createInstance()
    inst.state = 'running'
    new AiTaskRowRenderer(host).render(nameContainer, inst)

    const button = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-run-button:not(.ai-task-run-button--stop)',
    )
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('🤖')
    expect(button?.getAttribute('aria-label')).toBe('Run AI task')
    expect(taskItem.querySelector('.ai-task-run-button--stop')).toBeNull()
    expect(taskItem.querySelector('.ai-task-status-chip')).toBeNull()
  })

  test('running-task robot button keeps its normal start action and stops propagation', () => {
    const host = createHost()
    const inst = createInstance()
    inst.state = 'running'
    const parentClick = jest.fn()
    document.body.addEventListener('click', parentClick)

    new AiTaskRowRenderer(host).render(nameContainer, inst)
    const button = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-run-button:not(.ai-task-run-button--stop)',
    )
    button?.click()

    expect(host.startAiRun).toHaveBeenCalledWith(inst)
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)
  })
})
