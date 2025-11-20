import { normalizePath, TFile } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { DailySummaryEntry, TaskLogEntry, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'

export const RECORDS_VERSION = 1

type RecordScalar = string | number | boolean | null

export type RecordsEntry = Record<string, RecordScalar>

const RECORD_FIELDS: Array<keyof TaskLogEntry> = [
  'entryId',
  'deviceId',
  'taskId',
  'instanceId',
  'taskTitle',
  'taskName',
  'taskPath',
  'slotKey',
  'startTime',
  'stopTime',
  'durationSec',
  'duration',
  'isCompleted',
  'executionComment',
  'focusLevel',
  'energyLevel',
  'recordedAt',
]

function formatDuration(entry: TaskLogEntry): string {
  const durationSec = entry.durationSec ?? entry.duration ?? 0
  if (!durationSec) {
    return '-'
  }
  const minutes = Math.max(1, Math.round(durationSec / 60))
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
  }
  return `${minutes}m`
}

function compactObject<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value.length === 0) continue
      } else if (Object.keys(value as Record<string, unknown>).length === 0) {
        continue
      }
    }
    result[key as keyof T] = value as T[keyof T]
  }
  return result
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const inner = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')
  return `{${inner}}`
}

export function computeRecordsHash(records: RecordsEntry[]): string {
  const stable = records.map((record) => stableStringify(record)).join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
    hash >>>= 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function serializeRecordEntry(entry: TaskLogEntry): RecordsEntry {
  const record: RecordsEntry = {}
  for (const field of RECORD_FIELDS) {
    const value = entry[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    record[field as keyof RecordsEntry] = value as RecordScalar
  }
  return record
}

interface RecordWritePayload {
  dateKey: string
  entries: TaskLogEntry[]
  summary?: DailySummaryEntry
  canonicalRevision: number
  snapshotMeta?: TaskLogSnapshotMeta
}

export class RecordsWriter {
  constructor(private readonly plugin: TaskChutePluginLike) {}

  async writeDay(payload: RecordWritePayload): Promise<void> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const [year] = payload.dateKey.split('-')
    await this.plugin.pathManager.ensureFolderExists(logBase)
    const recordsRoot = normalizePath(`${logBase}/records`)
    await this.plugin.pathManager.ensureFolderExists(recordsRoot)
    const recordFolder = normalizePath(`${recordsRoot}/${year}`)
    await this.plugin.pathManager.ensureFolderExists(recordFolder)

    const filePath = normalizePath(`${recordFolder}/${payload.dateKey}.md`)
    const records = payload.entries.map((entry) => serializeRecordEntry(entry))
    const hash = computeRecordsHash(records)
    const frontmatter = compactObject({
      recordsVersion: RECORDS_VERSION,
      date: payload.dateKey,
      canonicalRevision: payload.canonicalRevision,
      generatedAt: new Date().toISOString(),
      entries: records.length,
      hash,
      dailySummary: payload.summary ?? undefined,
      snapshotMeta: payload.snapshotMeta ? compactObject(payload.snapshotMeta) : undefined,
      records,
    })
    const fm = serializeYaml(frontmatter).trimEnd()
    const table = this.buildTable(payload.entries)
    const content = `---\n${fm}\n---\n\n${table}\n`

    const existing = this.plugin.app.vault.getAbstractFileByPath(filePath)
    if (existing && existing instanceof TFile) {
      await this.plugin.app.vault.modify(existing, content)
    } else {
      await this.plugin.app.vault.create(filePath, content)
    }
  }

  private buildTable(entries: TaskLogEntry[]): string {
    const header = '| Start | Stop | Duration | Slot | Title | Device |\n| ----- | ---- | -------- | ---- | ----- | ------ |'
    if (entries.length === 0) {
      return `${header}\n| - | - | - | - | (no entries) | - |`
    }
    const rows = entries.map((entry) => {
      const start = entry.startTime ?? '-'
      const stop = entry.stopTime ?? '-'
      const duration = formatDuration(entry)
      const slot = entry.slotKey ?? '-'
      const title = entry.taskTitle ?? entry.taskName ?? entry.taskPath ?? 'Untitled task'
      const device = entry.deviceId ?? '-'
      return `| ${start} | ${stop} | ${duration} | ${slot} | ${title} | ${device} |`
    })
    return `${header}\n${rows.join('\n')}`
  }
}

function serializeYaml(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}[]`
    }
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${indent}- ${formatScalar(item)}`)
      } else {
        lines.push(`${indent}-`)
        lines.push(serializeYaml(item, depth + 1))
      }
    }
    return lines.join('\n')
  }

  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) {
        continue
      }
      if (isScalar(val)) {
        lines.push(`${indent}${key}: ${formatScalar(val)}`)
      } else {
        lines.push(`${indent}${key}:`)
        lines.push(serializeYaml(val, depth + 1))
      }
    }
    return lines.join('\n')
  }

  lines.push(`${indent}${formatScalar(value as RecordScalar)}`)
  return lines.join('\n')
}

function isScalar(value: unknown): value is RecordScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function formatScalar(value: RecordScalar): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `${value}` : 'null'
  }
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return `"${escaped}"`
}
