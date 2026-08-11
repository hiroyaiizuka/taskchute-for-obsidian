import { normalizePath } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogEntry } from '../../../types/ExecutionLog'
import { DeviceIdentityService } from '../../../services/DeviceIdentityService'
import { LOG_INBOX_FOLDER } from '../constants'

export type ExecutionLogDeltaOperation = 'upsert' | 'delete' | 'summary'

export interface ExecutionLogDeltaSummaryPayload {
  summary: {
    totalTasks: number
  }
}

export type ExecutionLogDeltaPayloadEntry = TaskLogEntry | ExecutionLogDeltaSummaryPayload

export interface ExecutionLogDeltaRecord {
  schemaVersion: number
  op: ExecutionLogDeltaOperation
  entryId: string
  deviceId: string
  monthKey: string
  dateKey: string
  recordedAt: string
  payload: ExecutionLogDeltaPayloadEntry
}

export interface ExecutionLogDeltaPayload {
  monthKey: string
  dateKey: string
  entry: ExecutionLogDeltaPayloadEntry
  operation?: ExecutionLogDeltaOperation
}

const DEFAULT_SCHEMA_VERSION = 1

export class ExecutionLogDeltaWriter {
  // Per-file write queue to prevent race conditions
  private writeQueues: Map<string, Promise<void>> = new Map()

  constructor(
    private readonly plugin: TaskChutePluginLike,
    private readonly deviceIdentity: DeviceIdentityService,
  ) {}

  async appendEntry(payload: ExecutionLogDeltaPayload): Promise<void> {
    const adapter = this.plugin.app.vault.adapter as
      | ({ append?: (path: string, data: string) => Promise<void> } & {
          read(path: string): Promise<string>
          write(path: string, data: string): Promise<void>
          exists?(path: string): Promise<boolean>
        })
      | undefined

    if (!adapter) {
      console.warn('[ExecutionLogDeltaWriter] Vault adapter unavailable; skip delta append')
      return
    }

    const deviceId = await this.deviceIdentity.getOrCreateDeviceId()
    const directory = await this.ensureDeviceInbox(deviceId)
    const deltaPath = normalizePath(`${directory}/${payload.monthKey}.jsonl`)

    // Queue writes to the same file to prevent race conditions
    const previousWrite = (this.writeQueues.get(deltaPath) ?? Promise.resolve()).catch(() => {})
    const currentWrite = previousWrite.then(async () => {
      await this.ensureFileExists(deltaPath, adapter)

      const record: ExecutionLogDeltaRecord = {
        schemaVersion: DEFAULT_SCHEMA_VERSION,
        op: payload.operation ?? 'upsert',
        entryId: this.generateEntryId(deviceId),
        deviceId,
        monthKey: payload.monthKey,
        dateKey: payload.dateKey,
        recordedAt: new Date().toISOString(),
        payload: { ...payload.entry },
      }

      const line = `${JSON.stringify(record)}\n`
      if (typeof adapter.append === 'function') {
        await adapter.append(deltaPath, line)
        return
      }

      const existing = await adapter.read(deltaPath)
      await adapter.write(deltaPath, `${existing}${line}`)
    })

    // Keep the queue flowing even if this write fails
    this.writeQueues.set(deltaPath, currentWrite.catch(() => {}))

    // Propagate error to caller while logging it
    try {
      await currentWrite
    } catch (err) {
      console.error('[ExecutionLogDeltaWriter] Write failed', deltaPath, err)
      throw err
    }
  }

  private async ensureDeviceInbox(deviceId: string): Promise<string> {
    const base = this.plugin.pathManager.getLogDataPath()
    await this.plugin.pathManager.ensureFolderExists(base)

    const inboxPath = normalizePath(`${base}/${LOG_INBOX_FOLDER}`)
    await this.plugin.pathManager.ensureFolderExists(inboxPath)

    const devicePath = normalizePath(`${inboxPath}/${deviceId}`)
    await this.plugin.pathManager.ensureFolderExists(devicePath)

    return devicePath
  }

  private async ensureFileExists(
    path: string,
    adapter: {
      exists?(path: string): Promise<boolean>
      read?(path: string): Promise<string>
      write(path: string, data: string): Promise<void>
    },
  ): Promise<void> {
    // 1. Use exists() if available
    if (typeof adapter.exists === 'function') {
      const exists = await adapter.exists(path)
      if (exists) {
        return
      }
    } else if (typeof adapter.read === 'function') {
      // 2. Fall back to read() for existence check when exists() is unavailable
      // This prevents overwriting existing files with empty content
      try {
        await adapter.read(path)
        return // File exists
      } catch {
        // File does not exist - proceed to create
      }
    }

    // 3. Create file only if it doesn't exist
    try {
      await adapter.write(path, '')
    } catch (e) {
      // Ignore error if file was created by another concurrent operation
      console.warn('[ExecutionLogDeltaWriter] ensureFileExists write failed (may be concurrent)', path, e)
    }
  }

  private generateEntryId(deviceId: string): string {
    const timePart = Date.now().toString(36)
    const randomPart = Math.random().toString(36).slice(2, 10)
    return `${deviceId}:${timePart}:${randomPart}`
  }
}
