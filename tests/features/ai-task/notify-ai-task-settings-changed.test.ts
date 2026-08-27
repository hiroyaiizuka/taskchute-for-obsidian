import type { App } from 'obsidian'

import { notifyAiTaskSettingsChanged } from '../../../src/features/ai-task/notifyAiTaskSettingsChanged'
import { VIEW_TYPE_TASKCHUTE } from '../../../src/types'

function makeApp(leaves: Array<{ view?: unknown }>): {
  app: App
  getLeavesOfType: jest.Mock
} {
  const getLeavesOfType = jest.fn((type: string) =>
    type === VIEW_TYPE_TASKCHUTE ? leaves : [],
  )
  return {
    app: { workspace: { getLeavesOfType } } as unknown as App,
    getLeavesOfType,
  }
}

describe('notifyAiTaskSettingsChanged', () => {
  test('pushes the change into every open TaskChute view', () => {
    const first = { onAiTaskSettingsChanged: jest.fn() }
    const second = { onAiTaskSettingsChanged: jest.fn() }
    const { app, getLeavesOfType } = makeApp([{ view: first }, { view: second }])

    notifyAiTaskSettingsChanged(app)

    expect(getLeavesOfType).toHaveBeenCalledWith(VIEW_TYPE_TASKCHUTE)
    expect(first.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
    expect(second.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
  })

  test('falls back to a plain re-render for a view without the hook', () => {
    const view = { renderTaskList: jest.fn() }
    const { app } = makeApp([{ view }])

    notifyAiTaskSettingsChanged(app)

    expect(view.renderTaskList).toHaveBeenCalledTimes(1)
  })

  test('prefers the hook over the re-render fallback', () => {
    const view = {
      onAiTaskSettingsChanged: jest.fn(),
      renderTaskList: jest.fn(),
    }
    const { app } = makeApp([{ view }])

    notifyAiTaskSettingsChanged(app)

    expect(view.onAiTaskSettingsChanged).toHaveBeenCalledTimes(1)
    expect(view.renderTaskList).not.toHaveBeenCalled()
  })

  test('tolerates detached leaves and a workspace without getLeavesOfType', () => {
    const { app } = makeApp([{ view: undefined }, {}])
    expect(() => {
      notifyAiTaskSettingsChanged(app)
    }).not.toThrow()

    const bareApp = { workspace: {} } as unknown as App
    expect(() => {
      notifyAiTaskSettingsChanged(bareApp)
    }).not.toThrow()
  })
})
