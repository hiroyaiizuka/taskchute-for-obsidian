import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type {
  DailySummaryEntry,
  TaskLogEntry,
  TaskLogSnapshot,
  TaskLogSnapshotMeta,
} from '../../../types/ExecutionLog'
import {
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
} from '../../../utils/executionLogUtils'
import { computeExecutionInstanceKey } from '../../../utils/logKeys'
import { computeRecordsHash, RECORDS_VERSION, RecordsEntry } from './RecordsWriter'
import { LogSnapshotWriter } from './LogSnapshotWriter'

interface RecordDayPayload {
  dateKey: string
  entries: TaskLogEntry[]
  summary?: DailySummaryEntry
  snapshotMeta?: TaskLogSnapshotMeta
  canonicalRevision?: number
  hash?: string
}

interface RebuildMonthContext {
  snapshot: TaskLogSnapshot
  metaRevision: number
  days: Set<string>
}

export interface RecordsRebuildStats {
  rebuiltMonths: number
  rebuiltDays: number
}

export class RecordsRebuilder {
  private readonly snapshotWriter: LogSnapshotWriter

  constructor(private readonly plugin: TaskChutePluginLike) {
    this.snapshotWriter = new LogSnapshotWriter(plugin)
  }

  async rebuildAllFromRecords(): Promise<RecordsRebuildStats> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const recordsRoot = normalizePath(`${logBase}/records`)
    const root = this.plugin.app.vault.getAbstractFileByPath(recordsRoot)
    if (!root || !(root instanceof TFolder)) {
      return { rebuiltMonths: 0, rebuiltDays: 0 }
    }

    const files = this.collectRecordFiles(root)
    if (files.length === 0) {
      return { rebuiltMonths: 0, rebuiltDays: 0 }
    }

    const monthContexts = new Map<string, RebuildMonthContext>()

    for (const file of files) {
      const payload = await this.parseRecordFile(file)
      if (!payload) continue
      const monthKey = payload.dateKey.slice(0, 7)
      let context = monthContexts.get(monthKey)
      if (!context) {
        context = {
          snapshot: createEmptyTaskLogSnapshot(),
          metaRevision: -1,
          days: new Set<string>(),
        }
        monthContexts.set(monthKey, context)
      }
      context.snapshot.taskExecutions[payload.dateKey] = payload.entries
      context.snapshot.dailySummary[payload.dateKey] = this.ensureDailySummary(
        payload.entries,
        payload.summary,
      )

      if (payload.snapshotMeta) {
        const revision = payload.snapshotMeta.revision ?? 0
        if (revision >= context.metaRevision) {
          context.metaRevision = revision
          context.snapshot.meta = {
            revision,
            lastProcessedAt: payload.snapshotMeta.lastProcessedAt,
            processedCursor: { ...(payload.snapshotMeta.processedCursor ?? {}) },
            lastBackupAt: payload.snapshotMeta.lastBackupAt,
          }
        }
      }

      context.days.add(payload.dateKey)
    }

    let rebuiltMonths = 0
    let rebuiltDays = 0

    for (const [monthKey, context] of monthContexts.entries()) {
      if (!context.snapshot.meta) {
        context.snapshot.meta = createEmptyTaskLogSnapshot().meta
      } else if (!context.snapshot.meta.processedCursor) {
        context.snapshot.meta.processedCursor = {}
      }
      await this.snapshotWriter.write(monthKey, context.snapshot, { forceBackup: true })
      rebuiltMonths += 1
      rebuiltDays += context.days.size
    }

    return { rebuiltMonths, rebuiltDays }
  }

  private collectRecordFiles(folder: TFolder): TFile[] {
    const files: TFile[] = []
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        files.push(...this.collectRecordFiles(child))
      } else if (child instanceof TFile && child.extension === 'md') {
        files.push(child)
      }
    }
    return files
  }

  private async parseRecordFile(file: TFile): Promise<RecordDayPayload | null> {
    try {
      const raw = await this.plugin.app.vault.read(file)
      const frontmatter = this.extractFrontmatter(raw)
      if (!frontmatter) {
        console.warn('[RecordsRebuilder] Missing frontmatter in record note', file.path)
        return null
      }
      const data = parseRecordFrontmatter(frontmatter)
      if (!data || typeof data !== 'object') {
        console.warn('[RecordsRebuilder] Invalid record frontmatter', file.path)
        return null
      }
      const version = typeof data.recordsVersion === 'number' ? data.recordsVersion : 0
      if (version !== RECORDS_VERSION) {
        console.warn('[RecordsRebuilder] Unsupported records version', version, file.path)
        return null
      }
      const dateKey = typeof data.date === 'string' ? data.date : this.deriveDateKey(file)
      if (!dateKey) {
        console.warn('[RecordsRebuilder] Unable to determine date for records file', file.path)
        return null
      }

      const recordsInput = Array.isArray(data.records) ? (data.records as unknown[]) : []
      const recordEntries: RecordsEntry[] = []
      const entries: TaskLogEntry[] = []
      for (const record of recordsInput) {
        const entryRecord = this.coerceRecordEntry(record)
        if (!entryRecord) continue
        recordEntries.push(entryRecord)
        entries.push(this.toTaskLogEntry(entryRecord))
      }

      if (recordEntries.length !== recordsInput.length) {
        console.warn('[RecordsRebuilder] Skipped malformed record entries', file.path)
      }

      if (typeof data.hash === 'string') {
        const computed = computeRecordsHash(recordEntries)
        if (computed !== data.hash) {
          console.warn('[RecordsRebuilder] Records hash mismatch', file.path)
        }
      }

      const summary = this.parseSummary(data.dailySummary)
      const snapshotMeta = this.parseSnapshotMeta(data.snapshotMeta)
      const canonicalRevision = typeof data.canonicalRevision === 'number' ? data.canonicalRevision : undefined

      return {
        dateKey,
        entries,
        summary,
        snapshotMeta,
        canonicalRevision,
        hash: typeof data.hash === 'string' ? data.hash : undefined,
      }
    } catch (error) {
      console.warn('[RecordsRebuilder] Failed to read record file', file.path, error)
      return null
    }
  }

  private extractFrontmatter(content: string): string | null {
    const normalized = content.replace(/\r\n/g, '\n')
    if (!normalized.startsWith('---')) {
      return null
    }
    const match = normalized.match(/^---\s*\n([\s\S]*?)\n---/)
    if (!match) {
      return null
    }
    return match[1]
  }

  private deriveDateKey(file: TFile): string | null {
    const base = file.basename
    if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
      return base
    }
    return null
  }

  private coerceRecordEntry(input: unknown): RecordsEntry | null {
    if (!input || typeof input !== 'object') {
      return null
    }
    const record: RecordsEntry = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        record[key] = value as RecordsEntry[keyof RecordsEntry]
      }
    }
    return record
  }

  private toTaskLogEntry(record: RecordsEntry): TaskLogEntry {
    return { ...record }
  }

  private parseSummary(input: unknown): DailySummaryEntry | undefined {
    if (!input || typeof input !== 'object') {
      return undefined
    }
    const source = input as Record<string, unknown>
    const summary: DailySummaryEntry = {}
    for (const key of ['totalMinutes', 'totalTasks', 'completedTasks', 'procrastinatedTasks', 'completionRate']) {
      const value = source[key]
      if (typeof value === 'number') {
        summary[key as keyof DailySummaryEntry] = value
      }
    }
    return summary
  }

  private parseSnapshotMeta(input: unknown): TaskLogSnapshotMeta | undefined {
    if (!input || typeof input !== 'object') {
      return undefined
    }
    const source = input as Record<string, unknown>
    const meta: TaskLogSnapshotMeta = {
      revision: typeof source.revision === 'number' ? source.revision : undefined,
      lastProcessedAt: typeof source.lastProcessedAt === 'string' ? source.lastProcessedAt : undefined,
      processedCursor: {},
      lastBackupAt: typeof source.lastBackupAt === 'string' ? source.lastBackupAt : undefined,
    }
    const cursorSource = source.processedCursor
    if (cursorSource && typeof cursorSource === 'object') {
      for (const [deviceId, cursor] of Object.entries(cursorSource as Record<string, unknown>)) {
        if (typeof cursor === 'number') {
          meta.processedCursor![deviceId] = cursor
        }
      }
    }
    return meta
  }

  private ensureDailySummary(entries: TaskLogEntry[], provided?: DailySummaryEntry): DailySummaryEntry {
    const totalMinutes = minutesFromLogEntries(entries)
    const completedSet = new Set<string>()
    for (const entry of entries) {
      if (isExecutionLogEntryCompleted(entry)) {
        completedSet.add(computeExecutionInstanceKey(entry))
      }
    }
    const completedTasks = completedSet.size
    const totalTasks = provided?.totalTasks ?? Math.max(completedTasks, entries.length)
    const procrastinatedTasks = Math.max(0, totalTasks - completedTasks)
    const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0

    return {
      ...(provided ?? {}),
      totalMinutes,
      totalTasks,
      completedTasks,
      procrastinatedTasks,
      completionRate,
    }
  }
}

type ParsedYaml = Record<string, unknown>

function parseRecordFrontmatter(frontmatter: string): ParsedYaml | null {
  const lines = frontmatter.split(/\r?\n/)
  const { value } = parseYamlObject(lines, 0, 0)
  return value
}

function parseYamlObject(
  lines: string[],
  startIndex: number,
  indent: number,
): { value: Record<string, unknown>; nextIndex: number } {
  const result: Record<string, unknown> = {}
  let index = startIndex
  while (index < lines.length) {
    const rawLine = lines[index]
    if (!rawLine.trim()) {
      index += 1
      continue
    }
    const currentIndent = rawLine.match(/^ */)?.[0].length ?? 0
    if (currentIndent < indent) {
      break
    }
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('-')) {
      break
    }
    const separatorIndex = trimmed.indexOf(':')
    if (separatorIndex === -1) {
      index += 1
      continue
    }
    const key = trimmed.slice(0, separatorIndex).trim()
    const remainder = trimmed.slice(separatorIndex + 1).trim()
    if (remainder.length > 0) {
      result[key] = parseYamlScalar(remainder)
      index += 1
      continue
    }
    const nextLine = lines[index + 1] ?? ''
    const nextIndent = nextLine.match(/^ */)?.[0].length ?? 0
    if (nextLine.trim().startsWith('-')) {
      const parsedArray = parseYamlArray(lines, index + 1, nextIndent)
      result[key] = parsedArray.value
      index = parsedArray.nextIndex
    } else {
      const parsedObj = parseYamlObject(lines, index + 1, currentIndent + 2)
      result[key] = parsedObj.value
      index = parsedObj.nextIndex
    }
  }
  return { value: result, nextIndex: index }
}

function parseYamlArray(
  lines: string[],
  startIndex: number,
  indent: number,
): { value: unknown[]; nextIndex: number } {
  const items: unknown[] = []
  let index = startIndex
  while (index < lines.length) {
    const rawLine = lines[index]
    if (!rawLine.trim()) {
      index += 1
      continue
    }
    const currentIndent = rawLine.match(/^ */)?.[0].length ?? 0
    if (currentIndent < indent) {
      break
    }
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('-')) {
      break
    }
    const remainder = trimmed.slice(1).trim()
    if (remainder.length > 0) {
      if (remainder.includes(':')) {
        const entry: Record<string, unknown> = {}
        index = consumeInlineObject(lines, index, indent, remainder, entry)
        items.push(entry)
        continue
      }
      items.push(parseYamlScalar(remainder))
      index += 1
      continue
    }
    const nextLine = lines[index + 1] ?? ''
    const nextIndent = nextLine.match(/^ */)?.[0].length ?? 0
    if (nextLine.trim().startsWith('-')) {
      const nested = parseYamlArray(lines, index + 1, nextIndent)
      items.push(nested.value)
      index = nested.nextIndex
    } else {
      const nestedObj = parseYamlObject(lines, index + 1, currentIndent + 2)
      items.push(nestedObj.value)
      index = nestedObj.nextIndex
    }
  }
  return { value: items, nextIndex: index }
}

function consumeInlineObject(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  firstLine: string,
  target: Record<string, unknown>,
): number {
  const separatorIndex = firstLine.indexOf(':')
  if (separatorIndex >= 0) {
    const key = firstLine.slice(0, separatorIndex).trim()
    const valuePart = firstLine.slice(separatorIndex + 1).trim()
    if (valuePart.length > 0) {
      target[key] = parseYamlScalar(valuePart)
    }
  }
  let index = startIndex + 1
  while (index < lines.length) {
    const rawLine = lines[index]
    if (!rawLine.trim()) {
      index += 1
      continue
    }
    const currentIndent = rawLine.match(/^ */)?.[0].length ?? 0
    if (currentIndent <= parentIndent) {
      break
    }
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('-')) {
      break
    }
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) {
      break
    }
    const key = trimmed.slice(0, colonIndex).trim()
    const valuePart = trimmed.slice(colonIndex + 1).trim()
    if (valuePart.length > 0) {
      target[key] = parseYamlScalar(valuePart)
      index += 1
      continue
    }
    const nested = parseYamlObject(lines, index + 1, currentIndent + 2)
    target[key] = nested.value
    index = nested.nextIndex
  }
  return index
}

function parseYamlScalar(token: string): string | number | boolean | null {
  if (token === 'null') return null
  if (token === 'true') return true
  if (token === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(token)) {
    return Number(token)
  }
  if (token.startsWith('"') && token.endsWith('"')) {
    return token
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return token
}
