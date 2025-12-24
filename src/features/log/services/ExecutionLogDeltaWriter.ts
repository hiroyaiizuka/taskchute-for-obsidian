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
      write(path: string, data: string): Promise<void>
    },
  ): Promise<void> {
    if (typeof adapter.exists === 'function') {
      const exists = await adapter.exists(path)
      if (exists) {
        return
      }
    }
    await adapter.write(path, '')
  }

  private generateEntryId(deviceId: string): string {
    const timePart = Date.now().toString(36)
    const randomPart = Math.random().toString(36).slice(2, 10)
    return `${deviceId}:${timePart}:${randomPart}`
  }
}
