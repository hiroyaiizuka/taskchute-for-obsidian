import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogEntry, TaskLogSnapshot, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
import { ExecutionLogDeltaRecord } from './ExecutionLogDeltaWriter'
import {
  createEmptyTaskLogSnapshot,
  isExecutionLogEntryCompleted,
  minutesFromLogEntries,
  parseTaskLogSnapshot,
} from '../../../utils/executionLogUtils'
import { computeExecutionInstanceKey } from '../../../utils/logKeys'
import { RecordsWriter } from './RecordsWriter'
import { LogSnapshotWriter } from './LogSnapshotWriter'
import { LOG_INBOX_FOLDER, LOG_INBOX_LEGACY_FOLDER } from '../constants'
import { BackupPruner } from './BackupPruner'

interface DeltaSource {
  deviceId: string
  monthKey: string
  filePath: string
}

interface MonthContext {
  monthKey: string
  snapshot: TaskLogSnapshot
  file: TFile | null
  previousRaw: string | null
  mutatedDates: Set<string>
  metaMutated: boolean
}

interface ReconcileStats {
  processedMonths: number
  processedEntries: number
}

interface SummaryMeta {
  recordedAt?: string
  deviceId?: string
  entryId?: string
}

export class LogReconciler {
  private readonly snapshotWriter: LogSnapshotWriter
  private readonly recordsWriter: RecordsWriter
  private readonly backupPruner: BackupPruner
  private lastBackupPrune = 0

  constructor(private readonly plugin: TaskChutePluginLike) {
    this.snapshotWriter = new LogSnapshotWriter(plugin)
    this.recordsWriter = new RecordsWriter(plugin)
    this.backupPruner = new BackupPruner(plugin)
  }

  async reconcilePendingDeltas(): Promise<ReconcileStats> {
    await this.pruneBackupsIfNeeded()
    const sources = await this.collectDeltaSources()
    if (sources.length === 0) {
      return { processedMonths: 0, processedEntries: 0 }
    }

    const grouped = new Map<string, DeltaSource[]>()
    for (const source of sources) {
      const list = grouped.get(source.monthKey)
      if (list) {
        list.push(source)
      } else {
        grouped.set(source.monthKey, [source])
      }
    }

    let processedEntries = 0
    let processedMonths = 0

    for (const [monthKey, monthSources] of grouped.entries()) {
      const stats = await this.processMonth(monthKey, monthSources)
      processedEntries += stats.processedEntries
      if (stats.processedEntries > 0) {
        processedMonths += 1
      }
    }

    return { processedMonths, processedEntries }
  }

  private async pruneBackupsIfNeeded(): Promise<void> {
    const now = Date.now()
    if (now - this.lastBackupPrune < 60 * 60 * 1000) {
      return
    }
    this.lastBackupPrune = now
    await this.backupPruner.prune()
  }

  private async collectDeltaSources(): Promise<DeltaSource[]> {
    const aggregated = new Map<string, DeltaSource>()
    for (const inboxPath of this.getDeltaInboxPaths()) {
      const fromVault = this.collectSourcesFromVaultTree(inboxPath)
      const fromAdapter = await this.collectSourcesFromAdapter(inboxPath)
      const merged = this.mergeSourceLists(fromVault, fromAdapter)
      for (const source of merged) {
        if (!aggregated.has(source.filePath)) {
          aggregated.set(source.filePath, source)
        }
      }
    }
    return Array.from(aggregated.values())
  }

  private getDeltaInboxPaths(): string[] {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const preferred = normalizePath(`${logBase}/${LOG_INBOX_FOLDER}`)
    const legacy = normalizePath(`${logBase}/${LOG_INBOX_LEGACY_FOLDER}`)
    if (preferred === legacy) {
      return [preferred]
    }
    return [preferred, legacy]
  }

  private collectSourcesFromVaultTree(inboxPath: string): DeltaSource[] {
    const root = this.plugin.app.vault.getAbstractFileByPath(inboxPath)
    if (!root || !(root instanceof TFolder)) {
      return []
    }

    const sources: DeltaSource[] = []
    for (const deviceFolder of root.children) {
      if (!(deviceFolder instanceof TFolder)) continue
      const deviceId = deviceFolder.name
      for (const child of deviceFolder.children) {
        if (!(child instanceof TFile)) continue
        if (!child.path.endsWith('.jsonl')) continue
        sources.push({ deviceId, monthKey: child.basename, filePath: child.path })
      }
    }
    return sources
  }

  private async collectSourcesFromAdapter(inboxPath: string): Promise<DeltaSource[]> {
    const adapter = this.plugin.app.vault.adapter as { list?: (path: string) => Promise<{ files: string[]; folders: string[] }> }
    if (!adapter || typeof adapter.list !== 'function') {
      return []
    }

    try {
      const listing = await adapter.list(inboxPath)
      const sources: DeltaSource[] = []
      for (const deviceFolder of listing.folders ?? []) {
        const deviceId = deviceFolder.split('/').pop() ?? deviceFolder
        let files: string[] = []
        try {
          const inner = await adapter.list(deviceFolder)
          files = inner.files ?? []
        } catch (error) {
          console.warn('[LogReconciler] Failed to list delta device folder', deviceFolder, error)
          continue
        }
        for (const filePath of files) {
          if (!filePath.endsWith('.jsonl')) continue
          const basename = filePath.split('/').pop()?.replace(/\.jsonl$/, '') ?? filePath
          sources.push({ deviceId, monthKey: basename, filePath })
        }
      }
      return sources
    } catch (error) {
      if (error && typeof error === 'object') {
        console.warn('[LogReconciler] Failed to list delta inbox', inboxPath, error)
      }
      return []
    }
  }

  private mergeSourceLists(primary: DeltaSource[], secondary: DeltaSource[]): DeltaSource[] {
    if (secondary.length === 0) {
      return primary
    }
    const merged = new Map<string, DeltaSource>()
    for (const source of [...primary, ...secondary]) {
      if (!merged.has(source.filePath)) {
        merged.set(source.filePath, source)
      }
    }
    return Array.from(merged.values())
  }

  private async processMonth(monthKey: string, sources: DeltaSource[]): Promise<{ processedEntries: number }> {
    const context = await this.loadMonthContext(monthKey)
    const meta = this.ensureMeta(context.snapshot.meta)
    context.snapshot.meta = meta
    const processedCursor = meta.processedCursor!
    let processedEntries = 0
    const affectedDates = context.mutatedDates

    for (const source of sources) {
      const records = await this.readDeltaRecords(source.filePath)
      if (records.length === 0) {
        if ((processedCursor?.[source.deviceId] ?? 0) !== 0) {
          processedCursor[source.deviceId] = 0
          context.metaMutated = true
        }
        continue
      }
      let startIndex = processedCursor?.[source.deviceId] ?? 0
      let cursorReset = false
      if (startIndex > records.length) {
        console.warn('[LogReconciler] Delta cursor exceeds file length, resetting', source.deviceId, source.monthKey)
        startIndex = 0
        processedCursor[source.deviceId] = 0
        context.metaMutated = true
        cursorReset = true
      }
      if (startIndex >= records.length && !cursorReset) {
        if (processedCursor[source.deviceId] !== records.length) {
          processedCursor[source.deviceId] = records.length
          context.metaMutated = true
        }
        continue
      }
      const sliceStart = cursorReset ? 0 : startIndex
      const newRecords = records.slice(sliceStart)
      const applied = this.applyRecordsToSnapshot(newRecords, context.snapshot, affectedDates)
      processedEntries += applied
      processedCursor[source.deviceId] = records.length
      context.metaMutated = context.metaMutated || applied > 0 || records.length !== startIndex
    }

    if (processedEntries > 0 || context.metaMutated) {
      this.finalizeMeta(context.snapshot)
      await this.persistSnapshot(context)
      await this.writeRecordEntries(context)
    }

    return { processedEntries }
  }

  private async loadMonthContext(monthKey: string): Promise<MonthContext> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const file = this.plugin.app.vault.getAbstractFileByPath(logPath)
    let snapshot: TaskLogSnapshot = createEmptyTaskLogSnapshot()
    let raw: string | null = null
    if (file && file instanceof TFile) {
      try {
        raw = await this.plugin.app.vault.read(file)
        snapshot = parseTaskLogSnapshot(raw)
      } catch (error) {
        console.warn('[LogReconciler] Failed to read snapshot', logPath, error)
        snapshot = createEmptyTaskLogSnapshot()
      }
    }

    snapshot.meta = this.ensureMeta(snapshot.meta)

    return {
      monthKey,
      snapshot,
      file: file instanceof TFile ? file : null,
      previousRaw: raw,
      mutatedDates: new Set<string>(),
      metaMutated: false,
    }
  }

  private async readDeltaRecords(path: string): Promise<ExecutionLogDeltaRecord[]> {
    try {
      const adapter = this.plugin.app.vault.adapter
      if (!adapter || typeof adapter.read !== 'function') {
        return []
      }
      const content = await adapter.read(path)
      if (!content) return []
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0)
      const records: ExecutionLogDeltaRecord[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ExecutionLogDeltaRecord
          records.push(parsed)
        } catch (error) {
          console.warn('[LogReconciler] Failed to parse delta line', path, error)
        }
      }
      return records
    } catch (error) {
      console.warn('[LogReconciler] Failed to read delta file', path, error)
      return []
    }
  }

  private applyRecordsToSnapshot(
    records: ExecutionLogDeltaRecord[],
    snapshot: TaskLogSnapshot,
    mutatedDates: Set<string>,
  ): number {
    let applied = 0
    for (const record of records) {
      const dateKey = record.dateKey
      if (!dateKey) continue
      const operation = record.op ?? 'upsert'
      if (operation === 'summary') {
        const summaryApplied = this.applySummaryRecord(record, snapshot)
        if (summaryApplied) {
          mutatedDates.add(dateKey)
          applied += 1
        }
        continue
      }
      const payloadEntry = record.payload as TaskLogEntry
      const normalizedEntry: TaskLogEntry = {
        ...payloadEntry,
        entryId: payloadEntry.entryId ?? record.entryId,
        deviceId: payloadEntry.deviceId ?? record.deviceId,
        recordedAt: payloadEntry.recordedAt ?? record.recordedAt,
      }
      if (operation === 'delete') {
        this.applyDeleteRecord(dateKey, normalizedEntry, snapshot)
        mutatedDates.add(dateKey)
        applied += 1
        continue
      }
      if (!Array.isArray(snapshot.taskExecutions[dateKey])) {
        snapshot.taskExecutions[dateKey] = []
      }
      const entries = snapshot.taskExecutions[dateKey]
      const idx = this.findMatchingEntryIndex(entries, normalizedEntry)
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], ...normalizedEntry }
      } else {
        entries.push(normalizedEntry)
      }
      mutatedDates.add(dateKey)
      applied += 1
    }
    return applied
  }

  private applySummaryRecord(record: ExecutionLogDeltaRecord, snapshot: TaskLogSnapshot): boolean {
    const payload = record.payload as { summary?: { totalTasks?: number } } | undefined
    const totalTasks = payload?.summary?.totalTasks
    if (typeof totalTasks !== 'number') {
      return false
    }
    const dateKey = record.dateKey
    if (!dateKey) {
      return false
    }

    const current = snapshot.dailySummary[dateKey] ?? {}
    const incomingMeta: SummaryMeta = {
      recordedAt: record.recordedAt,
      deviceId: record.deviceId,
      entryId: record.entryId,
    }
    this.warnIfClockSkew(incomingMeta.recordedAt)
    const existingMeta = this.readSummaryMeta(current)
    if (!this.isIncomingSummaryNewer(existingMeta, incomingMeta)) {
      return false
    }

    snapshot.dailySummary[dateKey] = {
      ...current,
      totalTasks,
      totalTasksRecordedAt: incomingMeta.recordedAt,
      totalTasksDeviceId: incomingMeta.deviceId,
      totalTasksEntryId: incomingMeta.entryId,
    }
    this.recomputeSummaryForDate(snapshot, dateKey)
    return true
  }

  private readSummaryMeta(summary: Record<string, unknown> | undefined): SummaryMeta {
    if (!summary) {
      return {}
    }
    return {
      recordedAt: typeof summary.totalTasksRecordedAt === 'string' ? summary.totalTasksRecordedAt : undefined,
      deviceId: typeof summary.totalTasksDeviceId === 'string' ? summary.totalTasksDeviceId : undefined,
      entryId: typeof summary.totalTasksEntryId === 'string' ? summary.totalTasksEntryId : undefined,
    }
  }

  private isIncomingSummaryNewer(current: SummaryMeta, incoming: SummaryMeta): boolean {
    const currentRecorded = current.recordedAt ?? ''
    const incomingRecorded = incoming.recordedAt ?? ''
    if (incomingRecorded !== currentRecorded) {
      return incomingRecorded > currentRecorded
    }
    const currentDevice = current.deviceId ?? ''
    const incomingDevice = incoming.deviceId ?? ''
    if (incomingDevice !== currentDevice) {
      return incomingDevice > currentDevice
    }
    const currentEntry = current.entryId ?? ''
    const incomingEntry = incoming.entryId ?? ''
    if (incomingEntry !== currentEntry) {
      return incomingEntry > currentEntry
    }
    return false
  }

  private warnIfClockSkew(recordedAt?: string): void {
    if (!recordedAt) {
      return
    }
    const recordedMillis = Date.parse(recordedAt)
    if (Number.isNaN(recordedMillis)) {
      return
    }
    const diff = Math.abs(Date.now() - recordedMillis)
    const threshold = 24 * 60 * 60 * 1000
    if (diff > threshold) {
      console.warn('[LogReconciler] Summary recordedAt skew detected', recordedAt)
    }
  }

  private applyDeleteRecord(dateKey: string, entry: TaskLogEntry, snapshot: TaskLogSnapshot): void {
    if (!Array.isArray(snapshot.taskExecutions[dateKey])) {
      snapshot.taskExecutions[dateKey] = []
      return
    }
    const targetInstanceId = entry.instanceId
    const targetTaskId = typeof entry.taskId === 'string' ? entry.taskId : undefined
    const entries = snapshot.taskExecutions[dateKey]
    const filtered = entries.filter((existing) => {
      if (!existing) return false
      if (targetInstanceId && existing.instanceId === targetInstanceId) {
        return false
      }
      if (targetTaskId && existing.taskId === targetTaskId) {
        return false
      }
      return true
    })
    snapshot.taskExecutions[dateKey] = filtered
  }

  private findMatchingEntryIndex(entries: TaskLogEntry[], candidate: TaskLogEntry): number {
    const targetInstanceId = typeof candidate.instanceId === 'string' ? candidate.instanceId : null
    const targetTaskId = typeof candidate.taskId === 'string' ? candidate.taskId : null
    const targetStart = typeof candidate.startTime === 'string' ? candidate.startTime : null
    const targetStop = typeof candidate.stopTime === 'string' ? candidate.stopTime : null
    const targetRecordedAt = typeof candidate.recordedAt === 'string' ? candidate.recordedAt : null

    return entries.findIndex((existing) => {
      if (!existing) return false
      if (targetInstanceId && existing.instanceId === targetInstanceId) {
        return true
      }
      if (targetTaskId && existing.taskId === targetTaskId) {
        if (targetStart && targetStop && existing.startTime === targetStart && existing.stopTime === targetStop) {
          return true
        }
        if (targetRecordedAt && existing.recordedAt === targetRecordedAt) {
          return true
        }
      }
      return false
    })
  }

  private finalizeMeta(snapshot: TaskLogSnapshot): void {
    const target = this.ensureMeta(snapshot.meta)
    snapshot.meta = target
    target.revision = (target.revision ?? 0) + 1
    target.lastProcessedAt = new Date().toISOString()
  }

  private ensureMeta(meta?: TaskLogSnapshotMeta): TaskLogSnapshotMeta {
    if (!meta) {
      const next: TaskLogSnapshotMeta = { revision: 0, processedCursor: {} }
      return next
    }
    if (!meta.processedCursor) {
      meta.processedCursor = {}
    }
    if (typeof meta.revision !== 'number') {
      meta.revision = 0
    }
    return meta
  }

  private async persistSnapshot(context: MonthContext): Promise<void> {
    const snapshot = context.snapshot
    for (const dateKey of context.mutatedDates) {
      this.recomputeSummaryForDate(snapshot, dateKey)
    }

    await this.snapshotWriter.write(context.monthKey, snapshot, {
      existingFile: context.file,
      previousRaw: context.previousRaw,
    })
  }

  private recomputeSummaryForDate(snapshot: TaskLogSnapshot, dateKey: string): void {
    const entries = snapshot.taskExecutions[dateKey] ?? []
    const totalMinutes = minutesFromLogEntries(entries)
    const completedSet = new Set<string>()
    for (const entry of entries) {
      if (isExecutionLogEntryCompleted(entry)) {
        completedSet.add(computeExecutionInstanceKey(entry))
      }
    }
    const completedTasks = completedSet.size
    const prev = snapshot.dailySummary[dateKey] || {}
    const totalTasks = typeof prev.totalTasks === 'number' ? prev.totalTasks : Math.max(completedTasks, entries.length)
    const procrastinatedTasks = Math.max(0, totalTasks - completedTasks)
    const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0

    snapshot.dailySummary[dateKey] = {
      ...prev,
      totalMinutes,
      totalTasks,
      completedTasks,
      procrastinatedTasks,
      completionRate,
    }
  }

  private async writeRecordEntries(context: MonthContext): Promise<void> {
    const meta = this.ensureMeta(context.snapshot.meta)
    const canonicalRevision = meta.revision ?? 0
    for (const dateKey of context.mutatedDates) {
      const entries = (context.snapshot.taskExecutions[dateKey] ?? [])
      await this.recordsWriter.writeDay({
        dateKey,
        entries,
        summary: context.snapshot.dailySummary[dateKey],
        canonicalRevision,
        snapshotMeta: meta,
      })
    }
  }
}
