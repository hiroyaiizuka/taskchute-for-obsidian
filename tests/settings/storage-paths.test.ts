import { PathManager } from '../../src/managers/PathManager'
import type { TaskChuteSettings } from '../../src/types'
import type { Plugin } from 'obsidian'

function makePathManager(settings: Partial<TaskChuteSettings>) {
  const plugin = { settings: settings as TaskChuteSettings } as unknown as Plugin & {
    settings: TaskChuteSettings
  }
  return new PathManager(plugin)
}

describe('PathManager storage path resolution', () => {
  test('vaultRoot base resolves to TaskChute/Task|Log|Review', () => {
    const pm = makePathManager({ locationMode: 'vaultRoot' })
    expect(pm.getTaskFolderPath()).toBe('TaskChute/Task')
    expect(pm.getLogDataPath()).toBe('TaskChute/Log')
    expect(pm.getReviewDataPath()).toBe('TaskChute/Review')
    expect(pm.getProjectFolderPath()).toBeNull()
  })

  test('specifiedFolder base resolves under that folder', () => {
    const pm = makePathManager({ locationMode: 'specifiedFolder', specifiedFolder: '02_Config' })
    expect(pm.getTaskFolderPath()).toBe('02_Config/TaskChute/Task')
    expect(pm.getLogDataPath()).toBe('02_Config/TaskChute/Log')
    expect(pm.getReviewDataPath()).toBe('02_Config/TaskChute/Review')
  })

  test('projectsFolder returns null when unset and normalized path when set', () => {
    const pm1 = makePathManager({ projectsFolder: null })
    expect(pm1.getProjectFolderPath()).toBeNull()

    const pm2 = makePathManager({ projectsFolder: '06_Projects' })
    expect(pm2.getProjectFolderPath()).toBe('06_Projects')
  })
})
