/**
 * ExecutionLogDeltaWriter のテスト
 *
 * TDD原則に基づいて、以下の修正箇所をテスト：
 * 1. ensureFileExists が adapter.exists がない場合に read() で存在確認すること
 * 2. ensureFileExists が既存ファイルを空で上書きしないこと
 * 3. 書き込みキューにより並行書き込みが直列化されること
 */
import { ExecutionLogDeltaWriter, type ExecutionLogDeltaPayload } from '../../src/features/log/services/ExecutionLogDeltaWriter'
import { DEVICE_ID_STORAGE_KEY } from '../../src/services/DeviceIdentityService'
import type { TaskChutePluginLike } from '../../src/types'

function primeDeviceId(id: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (id === null) {
    window.localStorage.removeItem(DEVICE_ID_STORAGE_KEY)
  } else {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
  }
}

interface AdapterMock {
  append?: jest.Mock<Promise<void>, [string, string]>
  read: jest.Mock<Promise<string>, [string]>
  write: jest.Mock<Promise<void>, [string, string]>
  exists?: jest.Mock<Promise<boolean>, [string]>
}

function createPluginStub(adapterOptions: {
  hasAppend?: boolean
  hasExists?: boolean
} = {}) {
  const deltaStore = new Map<string, string>()
  const writeCallOrder: Array<{ path: string; content: string; timestamp: number }> = []

  const adapter: AdapterMock = {
    read: jest.fn(async (path: string) => {
      const content = deltaStore.get(path)
      if (content === undefined) {
        throw new Error(`File not found: ${path}`)
      }
      return content
    }),
    write: jest.fn(async (path: string, data: string) => {
      writeCallOrder.push({ path, content: data, timestamp: Date.now() })
      deltaStore.set(path, data)
    }),
  }

  if (adapterOptions.hasAppend !== false) {
    adapter.append = jest.fn(async (path: string, data: string) => {
      const prev = deltaStore.get(path) ?? ''
      deltaStore.set(path, prev + data)
    })
  }

  if (adapterOptions.hasExists !== false) {
    adapter.exists = jest.fn(async (path: string) => deltaStore.has(path))
  }

  const pathManager = {
    getLogDataPath: () => 'LOGS',
    ensureFolderExists: jest.fn().mockResolvedValue(undefined),
  }

  const plugin: TaskChutePluginLike = {
    app: { vault: { adapter } },
    settings: {
      logDataPath: 'LOGS',
    },
    pathManager,
  } as unknown as TaskChutePluginLike

  return { plugin, deltaStore, adapter, writeCallOrder }
}

function createDeviceIdentityStub(deviceId: string) {
  return {
    getOrCreateDeviceId: jest.fn().mockResolvedValue(deviceId),
    getDeviceIdFromStorage: jest.fn().mockReturnValue(deviceId),
  }
}

function createPayload(overrides: Partial<ExecutionLogDeltaPayload> = {}): ExecutionLogDeltaPayload {
  return {
    monthKey: '2026-01',
    dateKey: '2026-01-30',
    entry: {
      instanceId: 'test-instance',
      taskId: 'test-task',
      taskTitle: 'Test Task',
      taskPath: 'TASKS/test.md',
      startTime: '09:00',
      stopTime: '10:00',
      durationSec: 3600,
    },
    ...overrides,
  }
}

beforeEach(() => {
  primeDeviceId(null)
})

describe('ExecutionLogDeltaWriter', () => {
  describe('ensureFileExists', () => {
    test('does not overwrite existing file when adapter.exists is available', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore, adapter } = createPluginStub({ hasAppend: true, hasExists: true })

      // Pre-create the file with existing content
      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'
      deltaStore.set(deltaPath, '{"existing":"data"}\n')

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      // File should have existing content + new entry, not be overwritten
      const content = deltaStore.get(deltaPath)!
      expect(content).toContain('{"existing":"data"}')
      expect(adapter.write).not.toHaveBeenCalledWith(deltaPath, '')
    })

    test('uses read() for existence check when adapter.exists is not available', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore, adapter } = createPluginStub({ hasAppend: false, hasExists: false })

      // Pre-create the file with existing content
      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'
      deltaStore.set(deltaPath, '{"existing":"data"}\n')

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      // read() should have been called to check existence
      expect(adapter.read).toHaveBeenCalledWith(deltaPath)

      // File should have existing content + new entry
      const content = deltaStore.get(deltaPath)!
      expect(content).toContain('{"existing":"data"}')
    })

    test('creates new file only when it does not exist (exists() available)', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore, adapter } = createPluginStub({ hasAppend: true, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'

      // exists() should have been called
      expect(adapter.exists).toHaveBeenCalledWith(deltaPath)

      // File should be created and contain the entry
      expect(deltaStore.has(deltaPath)).toBe(true)
    })

    test('creates new file only when read() throws (exists() not available)', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore, adapter } = createPluginStub({ hasAppend: false, hasExists: false })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'

      // read() should have been called to check existence
      expect(adapter.read).toHaveBeenCalledWith(deltaPath)

      // File should be created
      expect(deltaStore.has(deltaPath)).toBe(true)
    })
  })

  describe('write queue (race condition prevention)', () => {
    test('continues queued writes after a failed append', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore, adapter } = createPluginStub({ hasAppend: true, hasExists: true })

      let appendCount = 0
      adapter.append = jest.fn(async (path: string, data: string) => {
        appendCount += 1
        if (appendCount === 1) {
          throw new Error('disk full')
        }
        const prev = deltaStore.get(path) ?? ''
        deltaStore.set(path, prev + data)
      })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      const failedPayload = createPayload({ entry: { ...createPayload().entry, instanceId: 'inst-fail' } })
      const okPayload = createPayload({ entry: { ...createPayload().entry, instanceId: 'inst-ok' } })

      await expect(writer.appendEntry(failedPayload)).rejects.toThrow('disk full')
      await expect(writer.appendEntry(okPayload)).resolves.toBeUndefined()

      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'
      const content = deltaStore.get(deltaPath) ?? ''
      const lines = content.split('\n').filter((line) => line.trim().length > 0)
      expect(lines).toHaveLength(1)
      const instanceId = JSON.parse(lines[0]).payload.instanceId
      expect(instanceId).toBe('inst-ok')
    })

    test('serializes concurrent writes to the same file', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore } = createPluginStub({ hasAppend: false, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      // Create multiple payloads
      const payload1 = createPayload({ entry: { ...createPayload().entry, instanceId: 'inst-1' } })
      const payload2 = createPayload({ entry: { ...createPayload().entry, instanceId: 'inst-2' } })
      const payload3 = createPayload({ entry: { ...createPayload().entry, instanceId: 'inst-3' } })

      // Execute concurrently
      await Promise.all([
        writer.appendEntry(payload1),
        writer.appendEntry(payload2),
        writer.appendEntry(payload3),
      ])

      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'
      const content = deltaStore.get(deltaPath)!
      const lines = content.trim().split('\n')

      // All 3 entries should be present
      expect(lines.length).toBe(3)

      // Verify all instance IDs are present
      const instanceIds = lines.map(line => JSON.parse(line).payload.instanceId)
      expect(instanceIds).toContain('inst-1')
      expect(instanceIds).toContain('inst-2')
      expect(instanceIds).toContain('inst-3')
    })

    test('preserves all entries when writes are concurrent (no lost updates)', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore } = createPluginStub({ hasAppend: false, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      // Create 10 concurrent writes
      const payloads = Array.from({ length: 10 }, (_, i) =>
        createPayload({ entry: { ...createPayload().entry, instanceId: `inst-${i}` } })
      )

      await Promise.all(payloads.map(p => writer.appendEntry(p)))

      const deltaPath = 'LOGS/inbox/device-test/2026-01.jsonl'
      const content = deltaStore.get(deltaPath)!
      const lines = content.trim().split('\n')

      // All 10 entries should be present (no lost updates)
      expect(lines.length).toBe(10)
    })

    test('writes to different files are independent', async () => {
      primeDeviceId('device-test')
      const { plugin, deltaStore } = createPluginStub({ hasAppend: false, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      // Write to different month files
      const payload1 = createPayload({ monthKey: '2026-01', dateKey: '2026-01-15' })
      const payload2 = createPayload({ monthKey: '2026-02', dateKey: '2026-02-15' })

      await Promise.all([
        writer.appendEntry(payload1),
        writer.appendEntry(payload2),
      ])

      // Both files should exist with 1 entry each
      expect(deltaStore.get('LOGS/inbox/device-test/2026-01.jsonl')!.trim().split('\n').length).toBe(1)
      expect(deltaStore.get('LOGS/inbox/device-test/2026-02.jsonl')!.trim().split('\n').length).toBe(1)
    })
  })

  describe('append vs read-write fallback', () => {
    test('uses append() when available', async () => {
      primeDeviceId('device-test')
      const { plugin, adapter } = createPluginStub({ hasAppend: true, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      expect(adapter.append).toHaveBeenCalled()
    })

    test('falls back to read-write when append() is not available', async () => {
      primeDeviceId('device-test')
      const { plugin, adapter } = createPluginStub({ hasAppend: false, hasExists: true })

      const deviceIdentity = createDeviceIdentityStub('device-test')
      const writer = new ExecutionLogDeltaWriter(plugin, deviceIdentity as never)

      await writer.appendEntry(createPayload())

      // Should use read() then write()
      expect(adapter.read).toHaveBeenCalled()
      expect(adapter.write).toHaveBeenCalled()
    })
  })
})
