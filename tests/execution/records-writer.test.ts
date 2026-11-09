import { RecordsWriter } from '@/features/log/services/RecordsWriter'
import { createPluginStub } from './logTestUtils'

// LEV-388: the date key comes from log or backup JSON, which can be edited
// or synced from elsewhere, and becomes part of a vault path.
describe('RecordsWriter date keys', () => {
  test('writes the record of a real date', async () => {
    const { plugin, store } = createPluginStub()

    await new RecordsWriter(plugin).writeDay({ dateKey: '2026-02-28', entries: [], canonicalRevision: 1 })

    expect(Array.from(store.keys())).toEqual(['LOGS/records/2026/record-2026-02-28.md'])
  })

  test.each(['../../x', '2026-13-99', '2026-02-30', '2026-1-01', '../2026-01-01', ''])(
    'writes nothing for %p',
    async (dateKey) => {
      const { plugin, store } = createPluginStub()
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

      await new RecordsWriter(plugin).writeDay({ dateKey, entries: [], canonicalRevision: 1 })

      expect(store.size).toBe(0)
      expect(plugin.app.vault.create).not.toHaveBeenCalled()
      expect(plugin.app.vault.modify).not.toHaveBeenCalled()
      expect(plugin.pathManager.ensureFolderExists).not.toHaveBeenCalled()
      warn.mockRestore()
    },
  )
})

// LEV-408: a note write wakes plugins that watch the metadata cache, so a
// record whose contents did not change is left alone.
describe('RecordsWriter rewrites', () => {
  const entry = { taskTitle: 'Task A', taskPath: 'TASKS/a.md', startTime: '09:00', stopTime: '09:30', durationSec: 1800 }

  test('leaves an unchanged record alone', async () => {
    const { plugin } = createPluginStub()
    const writer = new RecordsWriter(plugin)
    const payload = { dateKey: '2026-11-10', entries: [entry], canonicalRevision: 1, summary: { totalTasks: 3 } }

    await writer.writeDay(payload)
    await writer.writeDay(payload)

    expect(plugin.app.vault.create).toHaveBeenCalledTimes(1)
    expect(plugin.app.vault.modify).not.toHaveBeenCalled()
  })

  test('rewrites a record whose contents changed', async () => {
    const { plugin, store } = createPluginStub()
    const writer = new RecordsWriter(plugin)

    await writer.writeDay({ dateKey: '2026-11-10', entries: [entry], canonicalRevision: 1, summary: { totalTasks: 3 } })
    await writer.writeDay({ dateKey: '2026-11-10', entries: [entry], canonicalRevision: 1, summary: { totalTasks: 4 } })

    expect(plugin.app.vault.modify).toHaveBeenCalledTimes(1)
    expect(store.get('LOGS/records/2026/record-2026-11-10.md')).toContain('totalTasks: 4')
  })
})
