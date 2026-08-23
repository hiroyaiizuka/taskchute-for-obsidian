/**
 * AiTaskRowRenderer duplicated-instance behavior: every AI task row keeps
 * the same 🤖 control, including while an AI run is active. Run ownership is
 * no longer represented in this secondary control; the row's primary
 * play/stop button is the single execution-state indicator and stop action.
 */
import { AiTaskRowRenderer } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { AiTaskRowRendererHost } from '../../../src/features/ai-task/ui/AiTaskRowRenderer'
import type { TaskInstance } from '../../../src/types'

function createInstance(
  instanceId: string,
  state: TaskInstance['state'] = 'idle',
): TaskInstance {
  return {
    task: {
      file: null,
      frontmatter: { ai_task: true },
      path: 'TASKS/ai-sample.md',
      name: 'AI sample',
      isRoutine: false,
    },
    instanceId,
    state,
    slotKey: 'none',
  } as TaskInstance
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

  test('running state does not replace the robot on either duplicate row', () => {
    const host = createHost()

    const owner = renderRow(host, createInstance('instance-2', 'running'))
    const other = renderRow(host, createInstance('instance-1'))

    for (const row of [owner, other]) {
      expect(row.querySelector('.ai-task-status-chip')).toBeNull()
      const button = row.querySelector('.ai-task-edit-button')
      expect(button).not.toBeNull()
      expect(button?.textContent).toBe('🤖')
    }
  })

  test('running-task robot opens the editor for its own instance', () => {
    const editAiTask = jest.fn()
    const host = createHost({ editAiTask })
    const inst = createInstance('instance-1', 'running')

    const taskItem = renderRow(host, inst)
    taskItem
      .querySelector<HTMLButtonElement>(
        '.ai-task-edit-button',
      )
      ?.click()

    expect(editAiTask).toHaveBeenCalledWith(inst)
  })
})
