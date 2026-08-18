import { PathService } from '../../../src/services/PathService'
import type { TaskChuteSettings } from '../../../src/types'
import type { Plugin } from 'obsidian'

function makePathService(settings: Partial<TaskChuteSettings>) {
  const plugin = { settings: settings as TaskChuteSettings } as unknown as Plugin & {
    settings: TaskChuteSettings
  }
  return new PathService(plugin)
}

describe('PathService AI log paths', () => {
  test('SUBDIR exposes aiLogs as AI/Logs', () => {
    expect(PathService.SUBDIR.aiLogs).toBe('AI/Logs')
  })

  test('vaultRoot base resolves to TaskChute/AI/Logs', () => {
    const pm = makePathService({ locationMode: 'vaultRoot' })
    expect(pm.getAiLogsPath()).toBe('TaskChute/AI/Logs')
    expect(pm.getAiLogsMonthPath('2026-07')).toBe('TaskChute/AI/Logs/2026-07')
  })

  test('specifiedFolder base resolves under that folder', () => {
    const pm = makePathService({
      locationMode: 'specifiedFolder',
      specifiedFolder: '02_Config',
    })
    expect(pm.getAiLogsPath()).toBe('02_Config/TaskChute/AI/Logs')
    expect(pm.getAiLogsMonthPath('2026-01')).toBe('02_Config/TaskChute/AI/Logs/2026-01')
  })
})
