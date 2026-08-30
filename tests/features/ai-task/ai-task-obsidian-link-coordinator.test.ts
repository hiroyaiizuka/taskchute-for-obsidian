import {
  AiTaskObsidianLinkCoordinator,
  resetAiTaskObsidianLinkRuntimeOwnershipForTests,
  type AiTaskObsidianLinkCoordinatorHost,
} from '../../../src/features/ai-task/services/AiTaskObsidianLinkCoordinator'
import type { TaskInstance } from '../../../src/types'

interface InstanceOptions {
  instanceId: string
  name: string
  state?: TaskInstance['state']
  ai?: boolean
  routine?: boolean
  routineEnabled?: boolean
  linkEnabled?: boolean
  matchType?: 'exact' | 'contains'
  matchTitle?: string
  displayTitle?: string
  frontmatterTitle?: string
  executedTitle?: string
}

function createInstance(options: InstanceOptions): TaskInstance {
  const frontmatter: Record<string, unknown> = {}
  if (options.ai) frontmatter['ai_task'] = true
  if (options.routine) frontmatter['isRoutine'] = true
  if (options.routineEnabled === false) frontmatter['routine_enabled'] = false
  if (options.matchTitle !== undefined) {
    frontmatter['obsidian_sync'] = {
      enabled: options.linkEnabled ?? true,
      taskTitle: options.matchTitle,
      matchType: options.matchType ?? 'exact',
    }
  }
  if (options.frontmatterTitle !== undefined) {
    frontmatter['title'] = options.frontmatterTitle
  }

  return {
    task: {
      file: null,
      frontmatter,
      path: `TASKS/${options.instanceId}.md`,
      name: options.name,
      displayTitle: options.displayTitle,
      isRoutine: options.routine ?? false,
      routine_enabled: options.routineEnabled,
    },
    instanceId: options.instanceId,
    state: options.state ?? 'idle',
    slotKey: 'none',
    executedTitle: options.executedTitle,
  }
}

function createHuman(
  instanceId = 'human-1',
  name = 'CEO review',
): TaskInstance {
  return createInstance({ instanceId, name })
}

function createAiTarget(
  instanceId: string,
  overrides: Partial<InstanceOptions> = {},
): TaskInstance {
  return createInstance({
    instanceId,
    name: `AI ${instanceId}`,
    ai: true,
    routine: true,
    matchTitle: 'CEO review',
    ...overrides,
  })
}

function createHost(instances: TaskInstance[]): {
  host: AiTaskObsidianLinkCoordinatorHost
  startLinkedAiTask: jest.MockedFunction<
    AiTaskObsidianLinkCoordinatorHost['startLinkedAiTask']
  >
  stopLinkedAiTask: jest.MockedFunction<
    AiTaskObsidianLinkCoordinatorHost['stopLinkedAiTask']
  >
} {
  const startLinkedAiTask = jest.fn(async (target: TaskInstance) => {
    target.state = 'running'
    return target
  })
  const stopLinkedAiTask = jest.fn(async (target: TaskInstance) => {
    target.state = 'done'
    return true
  })
  return {
    host: {
      getTaskInstances: () => instances,
      startLinkedAiTask,
      stopLinkedAiTask,
    },
    startLinkedAiTask,
    stopLinkedAiTask,
  }
}

describe('AiTaskObsidianLinkCoordinator', () => {
  beforeEach(() => {
    resetAiTaskObsidianLinkRuntimeOwnershipForTests()
  })

  test('starts only the first matching enabled AI routine', async () => {
    const source = createHuman()
    const first = createAiTarget('ai-first')
    const second = createAiTarget('ai-second')
    const { host, startLinkedAiTask } = createHost([source, first, second])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(startLinkedAiTask).toHaveBeenCalledWith(first)
  })

  test.each([
    {
      label: 'exact',
      sourceTitle: 'CEO review',
      matchTitle: 'CEO review',
      matchType: 'exact' as const,
    },
    {
      label: 'one-way contains',
      sourceTitle: 'Daily CEO review',
      matchTitle: 'CEO review',
      matchType: 'contains' as const,
    },
  ])('starts a target for a $label match', async (scenario) => {
    const source = createHuman('human-1', scenario.sourceTitle)
    const target = createAiTarget('ai-1', {
      matchTitle: scenario.matchTitle,
      matchType: scenario.matchType,
    })
    const { host, startLinkedAiTask } = createHost([source, target])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).toHaveBeenCalledWith(target)
  })

  test('does not reverse contains matching', async () => {
    const source = createHuman('human-1', 'CEO')
    const target = createAiTarget('ai-1', {
      matchTitle: 'Daily CEO review',
      matchType: 'contains',
    })
    const { host, startLinkedAiTask } = createHost([source, target])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).not.toHaveBeenCalled()
  })

  test('skips disabled linkage, disabled routine, non-routine, and non-AI candidates', async () => {
    const source = createHuman()
    const linkDisabled = createAiTarget('link-disabled', { linkEnabled: false })
    const routineDisabled = createAiTarget('routine-disabled', {
      routineEnabled: false,
    })
    const nonRoutine = createAiTarget('non-routine', { routine: false })
    const nonAi = createAiTarget('non-ai', { ai: false })
    const valid = createAiTarget('valid')
    const { host, startLinkedAiTask } = createHost([
      source,
      linkDisabled,
      routineDisabled,
      nonRoutine,
      nonAi,
      valid,
    ])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(startLinkedAiTask).toHaveBeenCalledWith(valid)
  })

  test('does not recurse when the source is itself an AI task', async () => {
    const source = createAiTarget('ai-source')
    const target = createAiTarget('ai-target', { matchTitle: source.task.name })
    const { host, startLinkedAiTask, stopLinkedAiTask } = createHost([
      source,
      target,
    ])

    const coordinator = new AiTaskObsidianLinkCoordinator(host)
    await coordinator.handleSourceStarted(source)
    source.state = 'running'
    await coordinator.handleSourceStopped(source)

    expect(startLinkedAiTask).not.toHaveBeenCalled()
    expect(stopLinkedAiTask).not.toHaveBeenCalled()
  })

  test('stops the owned target by mapped instance id even if candidate order changes', async () => {
    const source = createHuman()
    const owned = createAiTarget('owned')
    const instances = [source, owned]
    const { host, stopLinkedAiTask } = createHost(instances)
    const coordinator = new AiTaskObsidianLinkCoordinator(host)
    await coordinator.handleSourceStarted(source)

    const other = createAiTarget('other', { state: 'running' })
    instances.unshift(other)
    await coordinator.handleSourceStopped(source)

    expect(stopLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(stopLinkedAiTask).toHaveBeenCalledWith(owned)
  })

  test('owns the concrete instance returned by a duplicate start', async () => {
    const source = createHuman()
    const completed = createAiTarget('completed', { state: 'done' })
    const duplicate = createAiTarget('duplicate', { state: 'running' })
    const instances = [source, completed, duplicate]
    const { host, startLinkedAiTask, stopLinkedAiTask } = createHost(instances)
    startLinkedAiTask.mockResolvedValueOnce(duplicate)
    const coordinator = new AiTaskObsidianLinkCoordinator(host)

    await coordinator.handleSourceStarted(source)
    await coordinator.handleSourceStopped(source)

    expect(startLinkedAiTask).toHaveBeenCalledWith(completed)
    expect(stopLinkedAiTask).toHaveBeenCalledWith(duplicate)
    expect(stopLinkedAiTask).not.toHaveBeenCalledWith(completed)
  })

  test('stops a reloaded target object after coordinator recreation only when a prior coordinator recorded ownership', async () => {
    const source = createHuman()
    const target = createAiTarget('running')
    const firstHost = createHost([source, target])

    await new AiTaskObsidianLinkCoordinator(
      firstHost.host,
    ).handleSourceStarted(source)

    const reloadedSource = {
      ...source,
      task: { ...source.task, name: 'renamed human source' },
      state: 'done',
    } as TaskInstance
    const reloadedTarget = {
      ...target,
      task: {
        ...target.task,
        path: 'TASKS/renamed-running.md',
        frontmatter: {
          ...target.task.frontmatter,
          obsidian_sync: { enabled: false },
        },
      },
      state: 'running',
    } as TaskInstance
    const reloadedHost = createHost([reloadedSource, reloadedTarget])

    await new AiTaskObsidianLinkCoordinator(
      reloadedHost.host,
    ).handleSourceStopped(reloadedSource)

    expect(reloadedHost.stopLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(reloadedHost.stopLinkedAiTask).toHaveBeenCalledWith(reloadedTarget)
  })

  test('coalesces concurrent starts for one AI task and stops it only after the last matching source stops', async () => {
    const sourceA = createHuman('human-a')
    const sourceB = createHuman('human-b')
    sourceA.state = 'running'
    sourceB.state = 'running'
    const target = createAiTarget('ai-1')
    const { host, startLinkedAiTask, stopLinkedAiTask } = createHost([
      sourceA,
      sourceB,
      target,
    ])
    let resolveStart: ((value: TaskInstance) => void) | undefined
    startLinkedAiTask.mockImplementationOnce(
      () =>
        new Promise<TaskInstance>((resolve) => {
          resolveStart = resolve
        }),
    )
    const coordinator = new AiTaskObsidianLinkCoordinator(host)

    const startingA = coordinator.handleSourceStarted(sourceA)
    await Promise.resolve()
    const startingB = coordinator.handleSourceStarted(sourceB)
    await Promise.resolve()

    expect(startLinkedAiTask).toHaveBeenCalledTimes(1)
    target.state = 'running'
    resolveStart?.(target)
    await Promise.all([startingA, startingB])
    expect(startLinkedAiTask).toHaveBeenCalledTimes(1)

    sourceA.state = 'done'
    await coordinator.handleSourceStopped(sourceA)
    expect(stopLinkedAiTask).not.toHaveBeenCalled()

    sourceB.state = 'done'
    await coordinator.handleSourceStopped(sourceB)
    expect(stopLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(stopLinkedAiTask).toHaveBeenCalledWith(target)
  })

  test('does not stop a matching run after reload when no coordinator ownership evidence exists', async () => {
    const source = createHuman()
    const running = createAiTarget('running', { state: 'running' })
    const { host, stopLinkedAiTask } = createHost([source, running])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStopped(source)

    expect(stopLinkedAiTask).not.toHaveBeenCalled()
  })

  test('reload ownership is transferred while another matching human source is still running', async () => {
    const stoppedSource = createHuman('human-a')
    const stillRunningSource = createHuman('human-b')
    const target = createAiTarget('running')
    const { host, stopLinkedAiTask } = createHost([
      stoppedSource,
      stillRunningSource,
      target,
    ])
    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(
      stoppedSource,
    )

    stoppedSource.state = 'done'
    stillRunningSource.state = 'running'
    await new AiTaskObsidianLinkCoordinator(host).handleSourceStopped(
      stoppedSource,
    )
    expect(stopLinkedAiTask).not.toHaveBeenCalled()

    stillRunningSource.state = 'done'
    await new AiTaskObsidianLinkCoordinator(host).handleSourceStopped(
      stillRunningSource,
    )
    expect(stopLinkedAiTask).toHaveBeenCalledWith(target)
  })

  test('cancels an in-flight start and immediately stops the returned target when the source stops', async () => {
    const source = createHuman()
    source.state = 'running'
    const target = createAiTarget('ai-1')
    const { host, startLinkedAiTask, stopLinkedAiTask } = createHost([
      source,
      target,
    ])
    let resolveStart: ((value: TaskInstance) => void) | undefined
    startLinkedAiTask.mockImplementationOnce(
      () =>
        new Promise<TaskInstance>((resolve) => {
          resolveStart = resolve
        }),
    )
    const coordinator = new AiTaskObsidianLinkCoordinator(host)

    const starting = coordinator.handleSourceStarted(source)
    await Promise.resolve()
    source.state = 'done'
    await coordinator.handleSourceStopped(source)

    target.state = 'running'
    resolveStart?.(target)
    await starting

    expect(stopLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(stopLinkedAiTask).toHaveBeenCalledWith(target)

    // The cancelled completion must not install ownership that can stop the
    // same target a second time.
    await coordinator.handleSourceStopped(source)
    expect(stopLinkedAiTask).toHaveBeenCalledTimes(1)
  })

  test('does not fall back by title when an explicitly mapped target disappeared', async () => {
    const source = createHuman()
    const owned = createAiTarget('owned')
    const instances = [source, owned]
    const { host, stopLinkedAiTask } = createHost(instances)
    const coordinator = new AiTaskObsidianLinkCoordinator(host)
    await coordinator.handleSourceStarted(source)

    instances.splice(instances.indexOf(owned), 1)
    const unrelatedRun = createAiTarget('unrelated-running', {
      state: 'running',
    })
    instances.push(unrelatedRun)
    await coordinator.handleSourceStopped(source)

    expect(stopLinkedAiTask).not.toHaveBeenCalled()
  })

  test('prefers an already-running duplicate with the same task path over its idle template', async () => {
    const source = createHuman()
    const template = createAiTarget('template')
    const runningDuplicate = createAiTarget('duplicate', { state: 'running' })
    runningDuplicate.task.path = template.task.path
    const { host, startLinkedAiTask } = createHost([
      source,
      template,
      runningDuplicate,
    ])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).not.toHaveBeenCalled()
  })

  test('matches the canonical display title instead of a stale executed title', async () => {
    const source = createInstance({
      instanceId: 'human-1',
      name: 'file-name',
      displayTitle: 'CEO review',
      executedTitle: 'old executed title',
    })
    const target = createAiTarget('ai-1')
    const { host, startLinkedAiTask } = createHost([source, target])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).toHaveBeenCalledWith(target)
  })

  test('uses the shared frontmatter-title priority ahead of a stale display title', async () => {
    const source = createInstance({
      instanceId: 'human-1',
      name: 'file-name',
      displayTitle: 'stale display title',
      frontmatterTitle: 'CEO review',
      executedTitle: 'old executed title',
    })
    const target = createAiTarget('ai-1')
    const { host, startLinkedAiTask } = createHost([source, target])

    await new AiTaskObsidianLinkCoordinator(host).handleSourceStarted(source)

    expect(startLinkedAiTask).toHaveBeenCalledWith(target)
  })

  test('does not claim or stop a target that was already running', async () => {
    const source = createHuman()
    const alreadyRunning = createAiTarget('running', { state: 'running' })
    const { host, startLinkedAiTask, stopLinkedAiTask } = createHost([
      source,
      alreadyRunning,
    ])
    const coordinator = new AiTaskObsidianLinkCoordinator(host)

    await coordinator.handleSourceStarted(source)
    await coordinator.handleSourceStopped(source)

    expect(startLinkedAiTask).not.toHaveBeenCalled()
    expect(stopLinkedAiTask).not.toHaveBeenCalled()
  })

  test('keeps duplicate source-instance ownership independent', async () => {
    const sourceA = createHuman('human-a')
    const sourceB = createHuman('human-b')
    const target = createAiTarget('ai-1')
    const { host, stopLinkedAiTask } = createHost([sourceA, sourceB, target])
    const coordinator = new AiTaskObsidianLinkCoordinator(host)

    await coordinator.handleSourceStarted(sourceA)
    await coordinator.handleSourceStarted(sourceB)
    await coordinator.handleSourceStopped(sourceB)

    expect(stopLinkedAiTask).not.toHaveBeenCalled()
    expect(target.state).toBe('running')

    await coordinator.handleSourceStopped(sourceA)

    expect(stopLinkedAiTask).toHaveBeenCalledTimes(1)
    expect(stopLinkedAiTask).toHaveBeenCalledWith(target)
  })
})
