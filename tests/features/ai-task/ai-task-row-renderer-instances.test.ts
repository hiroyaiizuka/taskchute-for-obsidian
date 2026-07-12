/**
 * AiTaskRowRenderer instance association: when a task note has duplicated
 * rows, the status chip + stop control render ONLY on the row whose
 * inst.instanceId matches the active run's record.instanceId. Rows that do
 * not own the run show just the 🤖 run button. Legacy runs without an
 * instanceId fall back to the host's primary-instance resolution (the first
 * instance of the task path).
 */
import { AiTaskRowRenderer } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiTaskRowRendererHost } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiRunRecord } from '../../../src/features/ai-task/types'
import type { TaskInstance } from '../../../src/types'

function createInstance(instanceId: string): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: { ai_task: true },
      path: 'TASKS/ai-sample.md',
      name: 'AI sample',
      isRoutine: false,
    },
    instanceId,
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
    mode: 'terminal',
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

function renderRow(
  host: AiTaskRowRendererHost,
  inst: TaskInstance,
): HTMLElement {
  const taskItem = document.body.createDiv({ cls: 'task-item' })
  const nameContainer = taskItem.createSpan({ cls: 'task-name-container' })
  new AiTaskRowRenderer(host).render(nameContainer, inst)
  return taskItem
}

describe('AiTaskRowRenderer instance association', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  test('run with instanceId: only the matching row gets the chip and stop control', () => {
    const run = createRun({ instanceId: 'instance-2' })
    const host = createHost({ getActiveAiRun: () => run })

    const owner = renderRow(host, createInstance('instance-2'))
    const other = renderRow(host, createInstance('instance-1'))

    expect(owner.querySelector('.ai-task-status-chip')).not.toBeNull()
    expect(owner.querySelector('.ai-task-run-button--stop')).not.toBeNull()
    expect(owner.querySelector('.ai-task-run-button:not(.ai-task-run-button--stop)')).toBeNull()

    expect(other.querySelector('.ai-task-status-chip')).toBeNull()
    expect(other.querySelector('.ai-task-run-button--stop')).toBeNull()
    expect(
      other.querySelector('.ai-task-run-button:not(.ai-task-run-button--stop)'),
    ).not.toBeNull()
  })

  test('run without instanceId: falls back to the host primary-instance resolution', () => {
    const run = createRun({ instanceId: undefined })
    const host = createHost({
      getActiveAiRun: () => run,
      isPrimaryInstance: (inst) => inst.instanceId === 'instance-1',
    })

    const primary = renderRow(host, createInstance('instance-1'))
    const duplicate = renderRow(host, createInstance('instance-3'))

    expect(primary.querySelector('.ai-task-status-chip')).not.toBeNull()
    expect(primary.querySelector('.ai-task-run-button--stop')).not.toBeNull()

    expect(duplicate.querySelector('.ai-task-status-chip')).toBeNull()
    expect(duplicate.querySelector('.ai-task-run-button--stop')).toBeNull()
    expect(
      duplicate.querySelector('.ai-task-run-button:not(.ai-task-run-button--stop)'),
    ).not.toBeNull()
  })

  test('run without instanceId and no host resolver: every row keeps the chip (legacy behavior)', () => {
    const run = createRun({ instanceId: undefined })
    const host = createHost({ getActiveAiRun: () => run })

    const first = renderRow(host, createInstance('instance-1'))
    const second = renderRow(host, createInstance('instance-2'))

    expect(first.querySelector('.ai-task-status-chip')).not.toBeNull()
    expect(second.querySelector('.ai-task-status-chip')).not.toBeNull()
  })

  test('non-owning row run button still starts a run attempt for its own instance', () => {
    const run = createRun({ instanceId: 'instance-2' })
    const startAiRun = jest.fn()
    const host = createHost({ getActiveAiRun: () => run, startAiRun })
    const inst = createInstance('instance-1')

    const taskItem = renderRow(host, inst)
    taskItem
      .querySelector<HTMLButtonElement>(
        '.ai-task-run-button:not(.ai-task-run-button--stop)',
      )
      ?.click()

    expect(startAiRun).toHaveBeenCalledWith(inst)
  })
})
