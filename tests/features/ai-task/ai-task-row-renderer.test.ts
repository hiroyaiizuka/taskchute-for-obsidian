import { AiTaskRowRenderer } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiTaskRowRendererHost } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
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

function createRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run-1',
    taskPath: 'TASKS/ai-sample.md',
    taskName: 'AI sample',
    host: 'claude',
    mode: 'headless',
    status: 'running',
    startedAt: Date.now(),
    events: [],
    ...overrides,
  }
}

function createHost(
  overrides: Partial<AiTaskRowRendererHost> = {},
): AiTaskRowRendererHost {
  return {
    tv: (_key, fallback) => fallback,
    isAiTaskFeatureEnabled: () => true,
    getActiveAiRun: () => undefined,
    startAiRun: jest.fn(),
    stopAiRun: jest.fn(),
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

  test('renders a stop control and status chip while a run is active', () => {
    const run = createRun({ status: 'running' })
    const host = createHost({ getActiveAiRun: () => run })
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    const stopButton = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-run-button--stop',
    )
    expect(stopButton).not.toBeNull()
    expect(stopButton?.getAttribute('aria-label')).toBe('Stop AI task')

    const chip = taskItem.querySelector('.ai-task-status-chip')
    expect(chip).not.toBeNull()
    expect(chip?.classList.contains('ai-task-status-chip--running')).toBe(true)
    expect(chip?.textContent).toBe('Running')
  })

  test('stop control click stops the active run and stops propagation', () => {
    const run = createRun({ id: 'run-42', status: 'starting' })
    const host = createHost({ getActiveAiRun: () => run })
    const parentClick = jest.fn()
    document.body.addEventListener('click', parentClick)

    new AiTaskRowRenderer(host).render(nameContainer, createInstance())
    const stopButton = taskItem.querySelector<HTMLButtonElement>(
      '.ai-task-run-button--stop',
    )
    stopButton?.click()

    expect(host.stopAiRun).toHaveBeenCalledWith('run-42')
    expect(host.startAiRun).not.toHaveBeenCalled()
    expect(parentClick).not.toHaveBeenCalled()
    document.body.removeEventListener('click', parentClick)

    const chip = taskItem.querySelector('.ai-task-status-chip')
    expect(chip?.classList.contains('ai-task-status-chip--starting')).toBe(true)
  })

  test('uses the active run for the task path of the rendered instance', () => {
    const getActiveAiRun = jest.fn(() => undefined)
    const host = createHost({ getActiveAiRun })
    new AiTaskRowRenderer(host).render(nameContainer, createInstance())

    expect(getActiveAiRun).toHaveBeenCalledWith('TASKS/ai-sample.md')
  })
})
