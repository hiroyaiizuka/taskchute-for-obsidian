import { RecordsRebuilder } from '../../src/features/log/services/RecordsRebuilder'
import { computeRecordsHash } from '../../src/features/log/services/RecordsWriter'
import { createPluginStub, seedVaultFile } from './logTestUtils'

describe('RecordsRebuilder', () => {
  test('rebuilds monthly snapshot from records markdown', async () => {
    const { plugin, store, abstractStore } = createPluginStub()

    const recordEntries = [
      {
        entryId: 'device-alpha:1',
        deviceId: 'device-alpha',
        instanceId: 'inst-1',
        taskId: 'tc-task-record',
        taskTitle: 'Sample',
        taskPath: 'TASKS/sample.md',
        slotKey: 'morning',
        startTime: '08:00',
        stopTime: '08:30',
        durationSec: 1800,
      },
    ]

    const hash = computeRecordsHash(recordEntries)
    const frontmatter = [
      'recordsVersion: 1',
      'date: 2025-10-01',
      'canonicalRevision: 3',
      `hash: "${hash}"`,
      'snapshotMeta:',
      '  revision: 3',
      '  processedCursor:',
      '    device-alpha: 1',
      'dailySummary:',
      '  totalMinutes: 30',
      '  totalTasks: 1',
      '  completedTasks: 1',
      '  procrastinatedTasks: 0',
      '  completionRate: 1',
      'records:',
      '  - entryId: "device-alpha:1"',
      '    deviceId: "device-alpha"',
      '    instanceId: "inst-1"',
      '    taskId: "tc-task-record"',
      '    taskTitle: "Sample"',
      '    taskPath: "TASKS/sample.md"',
      '    slotKey: "morning"',
      '    startTime: "08:00"',
      '    stopTime: "08:30"',
      '    durationSec: 1800',
    ].join('\n')

    const table = '| Start | Stop | Duration | Slot | Title | Device |\n| ----- | ---- | -------- | ---- | ----- | ------ |\n| 08:00 | 08:30 | 30m | morning | Sample | device-alpha |'
    const recordContent = `---\n${frontmatter}\n---\n\n${table}\n`

    seedVaultFile(store, abstractStore, 'LOGS/records/2025/record-2025-10-01.md', recordContent)

    const rebuilder = new RecordsRebuilder(plugin)
    const stats = await rebuilder.rebuildAllFromRecords()

    expect(stats.rebuiltMonths).toBe(1)
    expect(stats.rebuiltDays).toBe(1)

    const snapshotRaw = store.get('LOGS/2025-10-tasks.json')
    expect(snapshotRaw).toBeDefined()
    const snapshot = JSON.parse(snapshotRaw!)
    expect(snapshot.taskExecutions['2025-10-01']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-10-01'][0].taskTitle).toBe('Sample')
    expect(snapshot.taskExecutions['2025-10-01'][0].taskId).toBe('tc-task-record')
    expect(snapshot.meta.revision).toBe(3)
    expect(snapshot.meta.processedCursor['device-alpha']).toBe(1)
  })

  test('derives dateKey from record-prefixed filename when date is missing', async () => {
    const { plugin, store, abstractStore } = createPluginStub()

    const recordEntries = [
      {
        entryId: 'device-alpha:2',
        deviceId: 'device-alpha',
        instanceId: 'inst-2',
        taskId: 'tc-task-derive',
        taskTitle: 'Derived',
        taskPath: 'TASKS/derived.md',
        slotKey: 'morning',
        startTime: '09:00',
        stopTime: '09:15',
        durationSec: 900,
      },
    ]

    const hash = computeRecordsHash(recordEntries)
    const frontmatter = [
      'recordsVersion: 1',
      'canonicalRevision: 1',
      `hash: "${hash}"`,
      'records:',
      '  - entryId: "device-alpha:2"',
      '    deviceId: "device-alpha"',
      '    instanceId: "inst-2"',
      '    taskId: "tc-task-derive"',
      '    taskTitle: "Derived"',
      '    taskPath: "TASKS/derived.md"',
      '    slotKey: "morning"',
      '    startTime: "09:00"',
      '    stopTime: "09:15"',
      '    durationSec: 900',
    ].join('\n')

    const table = '| Start | Stop | Duration | Slot | Title | Device |\n| ----- | ---- | -------- | ---- | ----- | ------ |\n| 09:00 | 09:15 | 15m | morning | Derived | device-alpha |'
    const recordContent = `---\n${frontmatter}\n---\n\n${table}\n`

    seedVaultFile(store, abstractStore, 'LOGS/records/2025/record-2025-10-02.md', recordContent)

    const rebuilder = new RecordsRebuilder(plugin)
    const stats = await rebuilder.rebuildAllFromRecords()

    expect(stats.rebuiltMonths).toBe(1)
    expect(stats.rebuiltDays).toBe(1)

    const snapshotRaw = store.get('LOGS/2025-10-tasks.json')
    expect(snapshotRaw).toBeDefined()
    const snapshot = JSON.parse(snapshotRaw!)
    expect(snapshot.taskExecutions['2025-10-02']).toHaveLength(1)
    expect(snapshot.taskExecutions['2025-10-02'][0].taskTitle).toBe('Derived')
  })
})
