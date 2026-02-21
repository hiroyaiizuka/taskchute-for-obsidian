import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogEntry, DailySummaryEntry, TaskLogSnapshot, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
import { SnapshotConflictError, SnapshotCorruptedError, LegacySnapshotError } from '../../../types/ExecutionLog'
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
import { LOG_INBOX_FOLDER, LOG_INBOX_LEGACY_FOLDER, LEGACY_REVISION } from '../constants'
import { BackupPruner } from './BackupPruner'
import { MonthSyncCoordinator } from './MonthSyncCoordinator'

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
  expectedRevision: number
}

export interface ReconcileStats {
  processedMonths: number
  processedEntries: number
}

interface SummaryMeta {
  recordedAt?: string
  deviceId?: string
  entryId?: string
}

interface IdentityOperationState {
  op: 'upsert' | 'delete'
  recordedAt: string
  deviceId: string
  entryId: string
}

type ReplayRequestReason = 'external-overwrite' | 'cache-content-changed' | 'terminal-missing'

type RecordIdentity = { kind: 'instanceId'; value: string }

interface NoOpCsrCacheEntry {
  revision: number
  recordsLength: number
  recordsSignature: string
  snapshotSignature: string
}

interface SourceCollectState {
  source: DeltaSource
  records: ExecutionLogDeltaRecord[]
  storedCursor: number
  startIndex: number
  cursorReset: boolean
  storedRevision: number | undefined
  csrCacheKey: string
  cachedEntry: NoOpCsrCacheEntry | undefined
  isCacheHit: boolean
}

interface CollectPhaseResult {
  sourceRecords: Map<string, ExecutionLogDeltaRecord[]>
  latestIdentityOps: Map<string, IdentityOperationState>
  replayRequests: Map<string, ReplayRequestReason>
  cursorNormalizationTargets: Map<string, number>
  sourceStates: SourceCollectState[]
  currentRevision: number
  currentSnapshotSignature: string
}

interface FoldSourcePlan {
  source: DeltaSource
  records: ExecutionLogDeltaRecord[]
  sliceStart: number
}

interface FoldPhaseResult {
  applied: number
  processed: number
}

interface ProcessMonthAccumulator {
  pendingCursors: Map<string, number>
  processedEntries: number
  noOpReplayDevices: Set<string>
  noOpReplayCursors: Map<string, number>
  eofSkippedDevices: Set<string>
  eofSkippedCursors: Map<string, number>
}

/**
 * LogReconciler依存関係インターフェース（DI対応）
 */
export interface LogReconcilerDeps {
  snapshotWriter: LogSnapshotWriter
  recordsWriter: RecordsWriter
  sleepFn: (ms: number) => Promise<void>
  randomFn: () => number
}

type JsonSerializable = string | number | boolean | null | JsonSerializable[] | { [key: string]: JsonSerializable | undefined }

const MAX_RETRIES = 3

export class LogReconciler {
  private readonly snapshotWriter: LogSnapshotWriter
  private readonly recordsWriter: RecordsWriter
  private readonly backupPruner: BackupPruner
  private lastBackupPrune = 0
  private readonly deps: LogReconcilerDeps

  /**
   * 揮発CSRキャッシュ: no-op確認済みの (monthKey:deviceId) を保持。
   * recordsSignature は「再生済みプレフィックス」の内容シグネチャで、
   * 同一件数上書き・先頭改変付き追記を検知して再replayの必要性を判断する。
   * snapshotSignature は no-op検証時点のスナップショット署名で、
   * 同revisionの外部上書きを検知して誤ヒットを防ぐ。
   */
  private noOpCsrCache = new Map<string, NoOpCsrCacheEntry>()

  constructor(private readonly plugin: TaskChutePluginLike, deps?: Partial<LogReconcilerDeps>) {
    this.snapshotWriter = deps?.snapshotWriter ?? new LogSnapshotWriter(plugin)
    this.recordsWriter = deps?.recordsWriter ?? new RecordsWriter(plugin)
    this.backupPruner = new BackupPruner(plugin)
    this.deps = {
      snapshotWriter: this.snapshotWriter,
      recordsWriter: this.recordsWriter,
      sleepFn: deps?.sleepFn ?? ((ms) => new Promise(r => setTimeout(r, ms))),
      randomFn: deps?.randomFn ?? Math.random,
    }
  }

  /** 成功書き込み後にnoOpCsrCacheの当該月エントリをクリア */
  private clearNoOpCacheForMonth(monthKey: string): void {
    const prefix = `${monthKey}:`
    for (const key of this.noOpCsrCache.keys()) {
      if (key.startsWith(prefix)) {
        this.noOpCsrCache.delete(key)
      }
    }
  }

  async reconcilePendingDeltas(): Promise<ReconcileStats> {
    await this.pruneBackupsIfNeeded()
    const sources = await this.collectDeltaSources()

    // P2-archived-month対応: アーカイブのみの月も検出
    // 保持期間後に通常.jsonlが削除されアーカイブのみ残る月を処理対象に追加
    const archivedOnlyMonths = await this.collectArchivedOnlyMonths(sources)

    if (sources.length === 0 && archivedOnlyMonths.length === 0) {
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

    // アーカイブのみの月を追加（空のソースリストで）
    for (const monthKey of archivedOnlyMonths) {
      if (!grouped.has(monthKey)) {
        grouped.set(monthKey, [])
      }
    }

    let processedEntries = 0
    let processedMonths = 0

    for (const [monthKey, monthSources] of grouped.entries()) {
      // 月単位でロックを取得して処理
      const stats = await this.withLock(monthKey, async () => {
        return await this.processMonthWithRetry(monthKey, monthSources)
      })
      processedEntries += stats.processedEntries
      if (stats.processedEntries > 0) {
        processedMonths += 1
      }
    }

    return { processedMonths, processedEntries }
  }

  /**
   * Promiseチェーン方式のミューテックス
   *
   * 動作原理:
   * 1. 既存のチェーン末尾（またはPromise.resolve()）を取得
   * 2. 自分のタスクをチェーン末尾に追加（.then()でチェーン）
   * 3. 新しい末尾をMapに保存
   *
   * これにより、同一monthKeyへの全リクエストが順番に実行される
   */
  private withLock<T>(monthKey: string, fn: () => Promise<T>): Promise<T> {
    return MonthSyncCoordinator.withMonthLock(monthKey, fn)
  }

  /**
   * テスト用ヘルパー - ロックの動作を検証するためのメソッド
   * @internal 本番コードでの使用は禁止
   */
  _testWithLock<T>(monthKey: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(monthKey, fn)
  }

  /**
   * 競合検出付きリトライロジック
   */
  private async processMonthWithRetry(monthKey: string, sources: DeltaSource[]): Promise<{ processedEntries: number }> {
    let retries = 0

    while (retries < MAX_RETRIES) {
      try {
        return await this.processMonth(monthKey, sources)
      } catch (e) {
        if (e instanceof SnapshotConflictError) {
          retries++
          console.warn(`[LogReconciler] Conflict retry ${retries}/${MAX_RETRIES} for ${monthKey}`)
          if (retries >= MAX_RETRIES) {
            // リトライ超過時はdeltaのみ保持し、次回に再試行
            console.error('[LogReconciler] Max retries exceeded, keeping deltas for next reconcile')
            return { processedEntries: 0 }
          }
          // 指数バックオフ + ジッター
          const delay = Math.min(1000 * Math.pow(2, retries) + this.deps.randomFn() * 500, 10000)
          await this.deps.sleepFn(delay)
          continue
        }

        if (e instanceof SnapshotCorruptedError) {
          console.warn(`[LogReconciler] ${e.name}: rebuilding from deltas`)
          await this.rebuildFromDeltas(monthKey, sources)
          return { processedEntries: 0 }
        }

        if (e instanceof LegacySnapshotError) {
          console.warn(`[LogReconciler] ${e.name}: migrating legacy snapshot`)
          await this.migrateLegacySnapshot(monthKey, e.legacySnapshot, sources)
          return { processedEntries: 0 }
        }

        throw e
      }
    }

    return { processedEntries: 0 }
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

  /**
   * アーカイブのみ存在する月を検出
   * P2-archived-month対応: 保持期間後に通常.jsonlが削除されアーカイブのみ残る月を検出
   *
   * @param normalSources 通常ソースリスト（collectDeltaSourcesの結果）
   * @returns 通常ソースにない月のリスト
   */
  private async collectArchivedOnlyMonths(normalSources: DeltaSource[]): Promise<string[]> {
    // 通常ソースに含まれる月を収集
    const normalMonths = new Set(normalSources.map(s => s.monthKey))
    const archivedOnlyMonths = new Set<string>()

    const adapter = this.plugin.app.vault.adapter as {
      list?: (path: string) => Promise<{ folders: string[]; files: string[] }>
    }
    if (!adapter?.list) {
      return []
    }

    for (const inboxPath of this.getDeltaInboxPaths()) {
      try {
        const listing = await adapter.list(inboxPath)
        if (!listing) continue

        for (const deviceFolder of listing.folders) {
          try {
            const deviceListing = await adapter.list(deviceFolder)
            if (!deviceListing) continue

            for (const filePath of deviceListing.files) {
              // アーカイブファイルのみ対象
              if (!filePath.endsWith('.archived.jsonl')) continue

              // 月キーを抽出: device/2026-01.archived.jsonl → 2026-01
              const basename = filePath.split('/').pop()?.replace(/\.archived\.jsonl$/, '') ?? ''
              if (!basename) continue

              // 通常ソースに含まれていない月のみ追加
              if (!normalMonths.has(basename)) {
                archivedOnlyMonths.add(basename)
              }
            }
          } catch {
            // デバイスフォルダの読み込み失敗は無視
          }
        }
      } catch {
        // inboxの読み込み失敗は無視
      }
    }

    return Array.from(archivedOnlyMonths)
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
        // アーカイブ済みdeltaは通常処理から除外
        if (child.path.endsWith('.archived.jsonl')) continue
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
          // アーカイブ済みdeltaは通常処理から除外
          if (filePath.endsWith('.archived.jsonl')) continue
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

  /**
   * アーカイブ専用ファイルを収集（通常の.jsonlが削除され.archived.jsonlのみ残っている場合）
   * Reviewer Issue P2-archived-only対応
   *
   * 通常ファイルがアーカイブ化された後、
   * そのデバイスの通常.jsonlは存在しないが.archived.jsonlは残る
   * このケースでもdeltaを取り込むために、アーカイブ専用ファイルを探索する
   */
  private async collectArchivedOnlyFiles(
    inboxPath: string,
    monthKey: string,
    alreadyProcessed: Set<string>,
    allRecordsByDevice: Map<string, ExecutionLogDeltaRecord[]>
  ): Promise<void> {
    const adapter = this.plugin.app.vault.adapter as { list?: (path: string) => Promise<{ files: string[]; folders: string[] }> }
    if (!adapter || typeof adapter.list !== 'function') {
      return
    }

    try {
      const listing = await adapter.list(inboxPath)
      for (const deviceFolder of listing.folders ?? []) {
        const deviceId = deviceFolder.split('/').pop() ?? deviceFolder
        let files: string[] = []
        try {
          const inner = await adapter.list(deviceFolder)
          files = inner.files ?? []
        } catch {
          continue
        }

        for (const filePath of files) {
          // .archived.jsonlファイルのみ対象
          if (!filePath.endsWith('.archived.jsonl')) continue

          // 既に処理済みならスキップ
          if (alreadyProcessed.has(filePath)) continue

          // このアーカイブの対象月を抽出: device/2026-02.archived.jsonl → 2026-02
          const basename = filePath.split('/').pop()?.replace(/\.archived\.jsonl$/, '') ?? ''
          if (basename !== monthKey) continue

          // このアーカイブを処理
          const records = await this.readDeltaRecords(filePath)
          if (records.length > 0) {
            alreadyProcessed.add(filePath)
            const existing = allRecordsByDevice.get(deviceId) ?? []
            allRecordsByDevice.set(deviceId, [...existing, ...records])
            console.warn(`[LogReconciler] Collected archived-only delta: ${filePath} (${records.length} records)`)
          }
        }
      }
    } catch {
      // エラーは無視（デバッグログも不要）
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

    // P2-missing-snapshot-order対応: スナップショットが存在しない場合はrebuildFromDeltasを使用
    // processMonth内で通常→アーカイブの順で適用すると、古いアーカイブが新しい通常を上書きするため
    // rebuildFromDeltasはアーカイブ→通常の正しい順序で適用する
    if (context.file === null) {
      console.warn(`[LogReconciler] No snapshot for ${monthKey}, using rebuildFromDeltas for correct ordering`)
      await this.rebuildFromDeltas(monthKey, sources)
      return { processedEntries: 0 }
    }

    const meta = this.ensureMeta(context.snapshot.meta)
    context.snapshot.meta = meta
    const accumulator = this.createProcessMonthAccumulator()
    const collected = await this.collectPhase(monthKey, sources, context, meta)
    if (collected.replayRequests.size > 0) {
      const replayDeviceIds = new Set(collected.replayRequests.keys())
      this.executeReplayPhase(monthKey, sources, context, meta, collected, accumulator)
      // replay対象外sourceの未処理tailは同サイクルで取り込む（起動時単発reconcileの取りこぼし防止）。
      this.executeIncrementalPhase(context, meta, collected, accumulator, replayDeviceIds)
    } else {
      this.executeIncrementalPhase(context, meta, collected, accumulator)
    }

    // P1-mixed-month対応: 通常sourcesが存在する月でも、archived-onlyのデバイスからdeltaを取り込む
    // シナリオ: デバイスAは通常.jsonl、デバイスBは.archived.jsonlのみの場合、
    // デバイスBのログが欠落しないようにする
    // P2-missing-snapshot-archived対応: スナップショット欠損時は全デバイスのarchivedも処理
    const snapshotMissing = context.file === null
    const archivedApplied = await this.applyArchivedOnlyDeltas(
      monthKey,
      sources,
      context.snapshot,
      context.mutatedDates,
      snapshotMissing,
    )
    if (archivedApplied > 0) {
      accumulator.processedEntries += archivedApplied
      context.metaMutated = true
    }

    await this.commitMonthChanges(monthKey, context, meta, accumulator)

    return { processedEntries: accumulator.processedEntries }
  }

  private createProcessMonthAccumulator(): ProcessMonthAccumulator {
    return {
      pendingCursors: new Map<string, number>(),
      processedEntries: 0,
      noOpReplayDevices: new Set<string>(),
      noOpReplayCursors: new Map<string, number>(),
      eofSkippedDevices: new Set<string>(),
      eofSkippedCursors: new Map<string, number>(),
    }
  }

  private executeReplayPhase(
    monthKey: string,
    sources: DeltaSource[],
    context: MonthContext,
    meta: TaskLogSnapshotMeta,
    collected: CollectPhaseResult,
    accumulator: ProcessMonthAccumulator,
  ): void {
    const { sourceRecords, latestIdentityOps, replayRequests, cursorNormalizationTargets, sourceStates, currentRevision } = collected
    const reasonSummary = Array.from(replayRequests.entries())
      .map(([deviceId, reason]) => `${deviceId}:${reason}`)
      .join(', ')
    console.warn('[LogReconciler] Month-level deterministic replay requested', monthKey, reasonSummary)
    const replayDeviceIds = new Set(replayRequests.keys())
    const sourceStateByDeviceId = new Map<string, SourceCollectState>()
    for (const state of sourceStates) {
      sourceStateByDeviceId.set(state.source.deviceId, state)
    }
    const resolvePreservedCursor = (deviceId: string, recordsLength: number): number => {
      const normalizedCursor = cursorNormalizationTargets.get(deviceId)
      if (normalizedCursor !== undefined) {
        return Math.min(recordsLength, Math.max(0, normalizedCursor))
      }
      const state = sourceStateByDeviceId.get(deviceId)
      const currentCursor = state?.storedCursor ?? meta.processedCursor?.[deviceId] ?? 0
      return Math.min(recordsLength, Math.max(0, currentCursor))
    }

    const replayRecords = this.buildMonthReplayRecords(
      sourceRecords,
      sources,
      replayRequests,
      latestIdentityOps,
    )
    const preSignature = this.computeSnapshotSignature(
      context.snapshot.taskExecutions,
      context.snapshot.dailySummary,
    )
    const replayAffectedDates = new Set<string>()
    const replayApplied = this.applyRecordsToSnapshot(
      replayRecords,
      context.snapshot,
      replayAffectedDates,
      { preferNewer: true, allowEqual: true },
    )
    const postSignature = this.computeSnapshotSignature(
      context.snapshot.taskExecutions,
      context.snapshot.dailySummary,
    )

    for (const [deviceId, cursor] of cursorNormalizationTargets) {
      accumulator.pendingCursors.set(deviceId, cursor)
      context.metaMutated = true
    }

    if (preSignature === postSignature) {
      if (!meta.cursorSnapshotRevision) {
        meta.cursorSnapshotRevision = {}
      }
      for (const source of sources) {
        const state = sourceStateByDeviceId.get(source.deviceId)
        const safeToCacheNonReplay = (
          !!state &&
          !state.cursorReset &&
          state.startIndex >= state.records.length
        )
        const shouldTrackNoOpSource = replayDeviceIds.has(source.deviceId) || safeToCacheNonReplay
        if (!shouldTrackNoOpSource) {
          continue
        }
        const records = sourceRecords.get(source.filePath) ?? []
        const csrCacheKey = `${monthKey}:${source.deviceId}`
        this.noOpCsrCache.set(csrCacheKey, {
          revision: currentRevision,
          recordsLength: records.length,
          recordsSignature: this.computeDeltaRecordsSignature(records),
          snapshotSignature: postSignature,
        })
        meta.cursorSnapshotRevision[source.deviceId] = currentRevision
        accumulator.noOpReplayDevices.add(source.deviceId)
        accumulator.noOpReplayCursors.set(source.deviceId, records.length)
      }

      if (currentRevision === LEGACY_REVISION) {
        for (const source of sources) {
          const records = sourceRecords.get(source.filePath) ?? []
          if (replayDeviceIds.has(source.deviceId)) {
            accumulator.pendingCursors.set(source.deviceId, records.length)
            continue
          }
          accumulator.pendingCursors.set(source.deviceId, resolvePreservedCursor(source.deviceId, records.length))
        }
        context.metaMutated = true
        console.warn('[LogReconciler] Legacy no-op month replay, forcing persist for migration', monthKey)
      } else {
        console.warn('[LogReconciler] No-op month replay, suppressing write', monthKey)
      }
      return
    }

    for (const d of replayAffectedDates) {
      context.mutatedDates.add(d)
    }
    const replayProcessedEntries = this.countReplayRequestedRecords(sources, sourceRecords, replayRequests)
    accumulator.processedEntries += replayProcessedEntries
    for (const source of sources) {
      const records = sourceRecords.get(source.filePath) ?? []
      if (replayDeviceIds.has(source.deviceId)) {
        accumulator.pendingCursors.set(source.deviceId, records.length)
        continue
      }
      accumulator.pendingCursors.set(source.deviceId, resolvePreservedCursor(source.deviceId, records.length))
    }
    context.metaMutated = true
    console.warn('[LogReconciler] Month-level replay applied',
      monthKey, `records=${replayRecords.length}`, `applied=${replayApplied}`, `processedEntries=${replayProcessedEntries}`)
  }

  private executeIncrementalPhase(
    context: MonthContext,
    meta: TaskLogSnapshotMeta,
    collected: CollectPhaseResult,
    accumulator: ProcessMonthAccumulator,
    excludedDeviceIds: Set<string> = new Set(),
  ): void {
    const { sourceStates, latestIdentityOps, cursorNormalizationTargets, currentRevision } = collected
    const processedCursor = meta.processedCursor!
    const foldPlans: FoldSourcePlan[] = []
    const cacheSkippedStates: SourceCollectState[] = []

    for (const state of sourceStates) {
      const { source, records, startIndex, cursorReset, storedRevision, csrCacheKey, cachedEntry, isCacheHit } = state
      if (excludedDeviceIds.has(source.deviceId)) {
        continue
      }
      if (records.length === 0) {
        if ((processedCursor?.[source.deviceId] ?? 0) !== 0) {
          accumulator.pendingCursors.set(source.deviceId, 0)
          context.metaMutated = true
        }
        continue
      }
      let sliceStart = cursorReset ? 0 : startIndex
      if (cursorReset) {
        console.warn('[LogReconciler] Delta cursor exceeds file length, resetting', source.deviceId, source.monthKey)
        accumulator.pendingCursors.set(source.deviceId, 0)
        context.metaMutated = true
      }

      if (isCacheHit && !cursorReset) {
        const refreshedSnapshotSignature = this.computeSnapshotSignature(
          context.snapshot.taskExecutions,
          context.snapshot.dailySummary,
        )
        const snapshotMutatedInThisCycle = (
          !!cachedEntry &&
          cachedEntry.snapshotSignature === collected.currentSnapshotSignature
        )
        if (!cachedEntry) {
          this.noOpCsrCache.delete(csrCacheKey)
          sliceStart = 0
        } else if (refreshedSnapshotSignature !== cachedEntry.snapshotSignature && !snapshotMutatedInThisCycle) {
          // キャッシュ作成後に同一reconcile外でスナップショットが変わった可能性があるため全再評価。
          this.noOpCsrCache.delete(csrCacheKey)
          sliceStart = 0
        } else {
          accumulator.noOpReplayDevices.add(source.deviceId)
          accumulator.noOpReplayCursors.set(source.deviceId, records.length)
          const prefixMatchesCache = (
            records.length >= cachedEntry.recordsLength &&
            this.computeDeltaRecordsSignature(records, cachedEntry.recordsLength) === cachedEntry.recordsSignature
          )
          if (records.length === cachedEntry.recordsLength && prefixMatchesCache) {
            const terminalUpsertMissing = this.hasMissingTerminalUpsert(context.snapshot, records, latestIdentityOps)
            if (terminalUpsertMissing) {
              this.noOpCsrCache.delete(csrCacheKey)
              sliceStart = 0
            } else {
              cacheSkippedStates.push(state)
              continue
            }
          } else if (records.length > cachedEntry.recordsLength && prefixMatchesCache) {
            sliceStart = cachedEntry.recordsLength
          } else {
            this.noOpCsrCache.delete(csrCacheKey)
            sliceStart = 0
          }
        }
      } else if (!cursorReset && (storedRevision === undefined || storedRevision !== currentRevision)) {
        sliceStart = 0
      } else if (startIndex >= records.length && !cursorReset) {
        const terminalUpsertMissing = this.hasMissingTerminalUpsert(context.snapshot, records, latestIdentityOps)
        if (terminalUpsertMissing) {
          sliceStart = 0
        } else {
          accumulator.eofSkippedDevices.add(source.deviceId)
          accumulator.eofSkippedCursors.set(source.deviceId, records.length)
          if (processedCursor[source.deviceId] !== records.length) {
            accumulator.pendingCursors.set(source.deviceId, records.length)
            context.metaMutated = true
          }
          continue
        }
      }

      foldPlans.push({ source, records, sliceStart })
    }

    if (foldPlans.length > 0) {
      const touchedIdentityKeys = this.collectIdentityKeysFromRecords(
        foldPlans.flatMap(plan => plan.records.slice(Math.max(0, plan.sliceStart))),
      )

      const folded = this.foldPhase(
        foldPlans,
        context.snapshot,
        context.mutatedDates,
        latestIdentityOps,
      )
      accumulator.processedEntries += folded.applied
      for (const plan of foldPlans) {
        accumulator.pendingCursors.set(plan.source.deviceId, plan.records.length)
      }
      if (folded.processed > 0) {
        context.metaMutated = true
      }

      // Branch1 complete-skip sourceでも、同一reconcile内の先行変更で対象identityが変化した場合は再foldする。
      if (cacheSkippedStates.length > 0 && touchedIdentityKeys.size > 0) {
        const signatureAfterFold = this.computeSnapshotSignature(
          context.snapshot.taskExecutions,
          context.snapshot.dailySummary,
        )
        const recoveryPlans: FoldSourcePlan[] = []
        for (const skippedState of cacheSkippedStates) {
          const cached = skippedState.cachedEntry
          if (!cached) {
            continue
          }
          if (signatureAfterFold === cached.snapshotSignature) {
            continue
          }
          if (!this.recordsTouchAnyIdentity(skippedState.records, touchedIdentityKeys)) {
            continue
          }
          recoveryPlans.push({ source: skippedState.source, records: skippedState.records, sliceStart: 0 })
        }
        if (recoveryPlans.length > 0) {
          const recovered = this.foldPhase(
            recoveryPlans,
            context.snapshot,
            context.mutatedDates,
            latestIdentityOps,
          )
          accumulator.processedEntries += recovered.applied
          for (const plan of recoveryPlans) {
            accumulator.pendingCursors.set(plan.source.deviceId, plan.records.length)
            accumulator.noOpReplayDevices.delete(plan.source.deviceId)
            accumulator.noOpReplayCursors.delete(plan.source.deviceId)
          }
          if (recovered.processed > 0) {
            context.metaMutated = true
          }
        }
      }
    }

    for (const [deviceId, cursor] of cursorNormalizationTargets) {
      if (!accumulator.pendingCursors.has(deviceId)) {
        accumulator.pendingCursors.set(deviceId, cursor)
        context.metaMutated = true
      }
    }
  }

  private async commitMonthChanges(
    monthKey: string,
    context: MonthContext,
    meta: TaskLogSnapshotMeta,
    accumulator: ProcessMonthAccumulator,
  ): Promise<void> {
    if (accumulator.processedEntries <= 0 && !context.metaMutated) {
      return
    }

    // processedCursorを反映してから書き込み
    for (const [deviceId, cursor] of accumulator.pendingCursors) {
      meta.processedCursor![deviceId] = cursor
    }

    // 外部上書き検知用: 書き込み後のrevisionを記録
    const nextRevision = context.expectedRevision + 1
    if (!meta.cursorSnapshotRevision) {
      meta.cursorSnapshotRevision = {}
    }
    // 通常の書き込みソースのCSRを更新
    for (const [deviceId] of accumulator.pendingCursors) {
      meta.cursorSnapshotRevision[deviceId] = nextRevision
    }
    // no-opソースのCSR + processedCursorもnextRevisionに揃える
    for (const deviceId of accumulator.noOpReplayDevices) {
      meta.cursorSnapshotRevision[deviceId] = nextRevision
      const noOpCursor = accumulator.noOpReplayCursors.get(deviceId)
      if (noOpCursor !== undefined) {
        meta.processedCursor![deviceId] = noOpCursor
      }
    }
    // EOFスキップのみだったソースもCSRをnextRevisionへ揃える
    for (const deviceId of accumulator.eofSkippedDevices) {
      meta.cursorSnapshotRevision[deviceId] = nextRevision
      const cursor = accumulator.eofSkippedCursors.get(deviceId)
      if (cursor !== undefined) {
        meta.processedCursor![deviceId] = cursor
      }
    }

    this.finalizeMeta(context.snapshot)
    await this.persistSnapshotWithConflictDetection(context)
    // 成功書き込み後: 揮発キャッシュをクリア
    this.clearNoOpCacheForMonth(monthKey)
    await this.writeRecordEntries(context)
  }

  private async collectPhase(
    monthKey: string,
    sources: DeltaSource[],
    context: MonthContext,
    meta: TaskLogSnapshotMeta,
  ): Promise<CollectPhaseResult> {
    const sourceRecords = new Map<string, ExecutionLogDeltaRecord[]>()
    const latestIdentityOps = new Map<string, IdentityOperationState>()
    const sourceStates: SourceCollectState[] = []
    const processedCursor = meta.processedCursor ?? {}
    const currentRevision = context.expectedRevision

    for (const source of sources) {
      const records = await this.readDeltaRecords(source.filePath)
      sourceRecords.set(source.filePath, records)
      this.updateLatestIdentityOperations(latestIdentityOps, records)

      const storedCursor = processedCursor[source.deviceId] ?? 0
      let startIndex = storedCursor
      let cursorReset = false
      if (startIndex > records.length) {
        startIndex = 0
        cursorReset = true
      }

      const storedRevision = meta.cursorSnapshotRevision?.[source.deviceId]
      const csrCacheKey = `${monthKey}:${source.deviceId}`
      const cachedEntry = this.noOpCsrCache.get(csrCacheKey)
      const isCacheHit = cachedEntry !== undefined && cachedEntry.revision === currentRevision

      sourceStates.push({
        source,
        records,
        storedCursor,
        startIndex,
        cursorReset,
        storedRevision,
        csrCacheKey,
        cachedEntry,
        isCacheHit,
      })
    }

    const currentSnapshotSignature = this.computeSnapshotSignature(
      context.snapshot.taskExecutions,
      context.snapshot.dailySummary,
    )
    const replayRequests = new Map<string, ReplayRequestReason>()
    const cursorNormalizationTargets = new Map<string, number>()

    for (const state of sourceStates) {
      const { source, records, storedCursor, startIndex, cursorReset, storedRevision, cachedEntry, isCacheHit } = state
      if (records.length === 0) {
        if (storedCursor !== 0) {
          cursorNormalizationTargets.set(source.deviceId, 0)
        }
        continue
      }

      if (cursorReset) {
        cursorNormalizationTargets.set(source.deviceId, 0)
      }

      if (isCacheHit && !cursorReset) {
        if (!cachedEntry || currentSnapshotSignature !== cachedEntry.snapshotSignature) {
          replayRequests.set(source.deviceId, 'external-overwrite')
          continue
        }
        const prefixMatchesCache = (
          records.length >= cachedEntry.recordsLength &&
          this.computeDeltaRecordsSignature(records, cachedEntry.recordsLength) === cachedEntry.recordsSignature
        )
        if (records.length === cachedEntry.recordsLength && prefixMatchesCache) {
          continue
        }
        if (records.length > cachedEntry.recordsLength && prefixMatchesCache) {
          continue
        }
        replayRequests.set(source.deviceId, 'cache-content-changed')
        continue
      }

      if (!cursorReset && (storedRevision === undefined || storedRevision !== currentRevision)) {
        replayRequests.set(source.deviceId, 'external-overwrite')
        continue
      }

      if (startIndex >= records.length && !cursorReset) {
        const terminalUpsertMissing = this.hasMissingTerminalUpsert(context.snapshot, records, latestIdentityOps)
        if (terminalUpsertMissing) {
          replayRequests.set(source.deviceId, 'terminal-missing')
        }
      }
    }

    return {
      sourceRecords,
      latestIdentityOps,
      replayRequests,
      cursorNormalizationTargets,
      sourceStates,
      currentRevision,
      currentSnapshotSignature,
    }
  }

  private foldPhase(
    plans: FoldSourcePlan[],
    snapshot: TaskLogSnapshot,
    mutatedDates: Set<string>,
    latestIdentityOps: Map<string, IdentityOperationState>,
  ): FoldPhaseResult {
    let processed = 0
    const aggregated: ExecutionLogDeltaRecord[] = []

    for (const plan of plans) {
      const records = plan.records.slice(Math.max(0, plan.sliceStart))
      if (records.length === 0) {
        continue
      }
      processed += records.length
      aggregated.push(...records)
    }

    if (aggregated.length === 0) {
      return { applied: 0, processed }
    }

    const filtered = this.filterReplayRecordsForFullReplay(aggregated, latestIdentityOps)
    const sorted = this.sortRecordsForFold(filtered)
    const applied = this.applyRecordsToSnapshot(
      sorted,
      snapshot,
      mutatedDates,
      { preferNewer: true, allowEqual: true },
    )

    return { applied, processed }
  }

  private sortRecordsForFold(records: ExecutionLogDeltaRecord[]): ExecutionLogDeltaRecord[] {
    if (records.length <= 1) {
      return records
    }
    const keyed = records.map((record, index) => ({
      record,
      index,
      stable: this.stableStringify(record as unknown as JsonSerializable),
    }))
    keyed.sort((a, b) => {
      const baseOrder = this.compareEntryOrder(a.record, b.record)
      if (baseOrder !== 0) {
        return baseOrder
      }

      const opOrder = this.compareFoldOpOrder(a.record.op, b.record.op)
      if (opOrder !== 0) {
        return opOrder
      }

      if (a.stable !== b.stable) {
        return a.stable < b.stable ? -1 : 1
      }
      return a.index - b.index
    })
    return keyed.map(entry => entry.record)
  }

  private compareFoldOpOrder(aOp: ExecutionLogDeltaRecord['op'], bOp: ExecutionLogDeltaRecord['op']): number {
    const a = aOp === 'delete' ? 'delete' : 'upsert'
    const b = bOp === 'delete' ? 'delete' : 'upsert'
    if (a === b) {
      return 0
    }
    // 同一順序キーでは delete を最後に適用して resurrection を防ぐ
    return a === 'upsert' ? -1 : 1
  }

  /**
   * P1-mixed-month対応: 通常sourcesには含まれないarchived-onlyデバイスのdeltaを適用
   * 通常の.jsonlを持つデバイスと、.archived.jsonlのみを持つデバイスが混在する月で、
   * 後者のログが欠落しないようにする
   */
  private async applyArchivedOnlyDeltas(
    monthKey: string,
    normalSources: DeltaSource[],
    snapshot: TaskLogSnapshot,
    affectedDates: Set<string>,
    snapshotMissing = false
  ): Promise<number> {
    // 通常sourcesに含まれるデバイスIDを収集
    const normalDeviceIds = new Set(normalSources.map(s => s.deviceId))

    // 各inboxパスでarchived-onlyデバイスを探索
    let appliedCount = 0
    for (const inboxPath of this.getDeltaInboxPaths()) {
      const adapter = this.plugin.app.vault.adapter as { list?: (path: string) => Promise<{ files: string[]; folders: string[] }> }
      if (!adapter || typeof adapter.list !== 'function') continue

      try {
        const listing = await adapter.list(inboxPath)
        for (const deviceFolder of listing.folders ?? []) {
          const deviceId = deviceFolder.split('/').pop() ?? deviceFolder

          // このデバイスのファイル一覧を取得
          let files: string[] = []
          try {
            const inner = await adapter.list(deviceFolder)
            files = inner.files ?? []
          } catch {
            continue
          }

          // このデバイスが通常.jsonlを持っているか確認
          const hasNormalDelta = files.some(f =>
            f.endsWith('.jsonl') && !f.endsWith('.archived.jsonl') &&
            f.split('/').pop()?.replace(/\.jsonl$/, '') === monthKey
          )

          // スナップショット欠損時以外は、通常sourcesに含まれるデバイスをスキップ
          // スナップショット欠損時は、通常sourceのデバイスでもarchivedを処理する
          if (!snapshotMissing) {
            if (normalDeviceIds.has(deviceId)) continue
            if (hasNormalDelta) continue // 通常deltaがあればスキップ（collectDeltaSourcesで処理される）
          }

          // archived.jsonlを適用
          for (const filePath of files) {
            if (!filePath.endsWith('.archived.jsonl')) continue
            const basename = filePath.split('/').pop()?.replace(/\.archived\.jsonl$/, '') ?? ''
            if (basename !== monthKey) continue

            const records = await this.readDeltaRecords(filePath)
            if (records.length > 0) {
              const sortedRecords = [...records].sort((a, b) => {
                const timeA = a.recordedAt ?? ''
                const timeB = b.recordedAt ?? ''
                return timeA.localeCompare(timeB)
              })
              const applied = this.applyRecordsToSnapshot(sortedRecords, snapshot, affectedDates, { preferNewer: true })
              appliedCount += applied
              const reason = snapshotMissing ? 'snapshot-missing' : 'archived-only'
              console.warn(`[LogReconciler] Applied archived delta (${reason}) from ${deviceId}: ${filePath} (${records.length} records, ${applied} applied)`)
            }
          }
        }
      } catch {
        // inboxの読み込み失敗は無視
      }
    }

    return appliedCount
  }

  private async loadMonthContext(monthKey: string): Promise<MonthContext> {
    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const file = this.plugin.app.vault.getAbstractFileByPath(logPath)
    let snapshot: TaskLogSnapshot = createEmptyTaskLogSnapshot()
    let raw: string | null = null
    let expectedRevision = 0

    if (file && file instanceof TFile) {
      try {
        raw = await this.plugin.app.vault.read(file)
        snapshot = parseTaskLogSnapshot(raw)

        // rawデータでmetaフィールドの有無を判定（parseTaskLogSnapshotはmeta無しでもrevision=0を補完するため）
        // metaフィールドがない旧形式スナップショットはLEGACY_REVISIONとして扱う
        let hasMetaInRaw = false
        try {
          const rawParsed = JSON.parse(raw) as { meta?: unknown }
          hasMetaInRaw = rawParsed.meta !== undefined && rawParsed.meta !== null
        } catch {
          // parse失敗は破損扱い
        }

        if (!hasMetaInRaw) {
          // 旧形式スナップショット: LEGACY_REVISION(-1)として移行を強制
          expectedRevision = LEGACY_REVISION
          console.warn(`[LogReconciler] Legacy snapshot detected (no meta field): ${logPath}`)
        } else {
          // 新形式: revisionを取得
          expectedRevision = typeof snapshot.meta?.revision === 'number'
            ? snapshot.meta.revision
            : LEGACY_REVISION
        }
      } catch (error) {
        // スナップショットが破損している場合、deltaから再構築を試みる
        console.warn('[LogReconciler] Failed to read snapshot, will rebuild from deltas', logPath, error)
        throw new SnapshotCorruptedError(logPath)
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
      expectedRevision,
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
    options?: { preferNewer?: boolean; allowEqual?: boolean },
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
      const normalizedInstanceId = this.normalizeInstanceId(normalizedEntry.instanceId)
      if (!normalizedInstanceId) {
        continue
      }
      normalizedEntry.instanceId = normalizedInstanceId

      if (operation === 'delete') {
        const entries = snapshot.taskExecutions[dateKey]
        if (!Array.isArray(entries)) {
          continue
        }
        const targetIdx = this.findDeleteTargetIndex(entries, normalizedEntry)
        if (targetIdx < 0) {
          continue
        }
        if (options?.preferNewer) {
          const existing = entries[targetIdx]
          if (existing && this.compareEntryOrder(normalizedEntry, existing) < 0) {
            continue
          }
        }
        entries.splice(targetIdx, 1)
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
        if (options?.preferNewer) {
          const compare = this.compareEntryOrder(normalizedEntry, entries[idx])
          if (compare < 0) {
            continue
          }
          if (compare === 0 && !options.allowEqual && !this.isIncomingEntryNewer(entries[idx], normalizedEntry)) {
            continue
          }
        }
        entries[idx] = { ...entries[idx], ...normalizedEntry }
      } else {
        entries.push(normalizedEntry)
      }
      mutatedDates.add(dateKey)
      applied += 1
    }
    return applied
  }

  /**
   * 単一レコードをスナップショットに適用（マイグレーション用）
   */
  private applyRecordToSnapshot(record: ExecutionLogDeltaRecord, snapshot: TaskLogSnapshot): void {
    const dateKey = record.dateKey
    if (!dateKey) return
    const operation = record.op ?? 'upsert'

    if (operation === 'summary') {
      this.applySummaryRecord(record, snapshot)
      return
    }

    const payloadEntry = record.payload as TaskLogEntry
    const normalizedEntry: TaskLogEntry = {
      ...payloadEntry,
      entryId: payloadEntry.entryId ?? record.entryId,
      deviceId: payloadEntry.deviceId ?? record.deviceId,
      recordedAt: payloadEntry.recordedAt ?? record.recordedAt,
    }
    const normalizedInstanceId = this.normalizeInstanceId(normalizedEntry.instanceId)
    if (!normalizedInstanceId) {
      return
    }
    normalizedEntry.instanceId = normalizedInstanceId

    if (operation === 'delete') {
      this.applyDeleteRecord(dateKey, normalizedEntry, snapshot)
      return
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

  private isIncomingEntryNewer(current: TaskLogEntry, incoming: TaskLogEntry): boolean {
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

  private compareEntryOrder(a: TaskLogEntry, b: TaskLogEntry): number {
    const recordedA = a.recordedAt ?? ''
    const recordedB = b.recordedAt ?? ''
    if (recordedA !== recordedB) {
      return recordedA < recordedB ? -1 : 1
    }
    const deviceA = a.deviceId ?? ''
    const deviceB = b.deviceId ?? ''
    if (deviceA !== deviceB) {
      return deviceA < deviceB ? -1 : 1
    }
    const entryA = a.entryId ?? ''
    const entryB = b.entryId ?? ''
    if (entryA !== entryB) {
      return entryA < entryB ? -1 : 1
    }
    return 0
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

  private findDeleteTargetIndex(entries: TaskLogEntry[], entry: TaskLogEntry): number {
    const targetInstanceId = this.normalizeInstanceId(entry.instanceId)
    if (!targetInstanceId) {
      return -1
    }
    return entries.findIndex((existing) => this.normalizeInstanceId(existing?.instanceId) === targetInstanceId)
  }

  private applyDeleteRecord(dateKey: string, entry: TaskLogEntry, snapshot: TaskLogSnapshot): void {
    if (!Array.isArray(snapshot.taskExecutions[dateKey])) {
      snapshot.taskExecutions[dateKey] = []
      return
    }
    const entries = snapshot.taskExecutions[dateKey]
    const idx = this.findDeleteTargetIndex(entries, entry)
    if (idx >= 0) {
      entries.splice(idx, 1)
    }
  }

  private findMatchingEntryIndex(entries: TaskLogEntry[], candidate: TaskLogEntry): number {
    const targetInstanceId = this.normalizeInstanceId(candidate.instanceId)
    if (!targetInstanceId) {
      return -1
    }

    return entries.findIndex((existing) => {
      if (!existing) return false
      return this.normalizeInstanceId(existing.instanceId) === targetInstanceId
    })
  }

  /**
   * Deltaレコード配列の順序付き内容シグネチャ。
   * no-opキャッシュのプレフィックス検証に使用する。
   */
  private computeDeltaRecordsSignature(records: ExecutionLogDeltaRecord[], takeCount = records.length): string {
    const limit = Math.min(records.length, Math.max(0, takeCount))
    if (limit === 0) {
      return '0:0:0000000000000000'
    }
    let totalBytes = 0
    let hashA = 2166136261
    let hashB = 5381
    for (let i = 0; i < limit; i++) {
      const encoded = this.stableStringify(records[i] as unknown as JsonSerializable)
      totalBytes += encoded.length
      hashA = this.hashFnv1a(hashA, `${encoded.length}:`)
      hashA = this.hashFnv1a(hashA, encoded)
      hashA = this.hashFnv1a(hashA, '|')

      hashB = this.hashDjb2(hashB, `${encoded.length}:`)
      hashB = this.hashDjb2(hashB, encoded)
      hashB = this.hashDjb2(hashB, '|')
    }
    return `${limit}:${totalBytes}:${this.toHex32(hashA)}${this.toHex32(hashB)}`
  }

  /**
   * taskExecutions + dailySummary のフルコンテンツシグネチャを生成。
   * full replay前後で比較し、no-op検知に使用。
   */
  private computeSnapshotSignature(
    taskExecutions: Record<string, TaskLogEntry[]>,
    dailySummary: Record<string, DailySummaryEntry>,
  ): string {
    const teParts: string[] = []
    const taskExecutionsRecord = taskExecutions as Record<string, unknown>
    for (const date of Object.keys(taskExecutions).sort()) {
      const rawEntries = taskExecutionsRecord[date]
      const entries = Array.isArray(rawEntries) ? rawEntries as TaskLogEntry[] : []
      const entrySignatures = entries
        .map(e => this.stableStringify(e as unknown as JsonSerializable))
        .sort()
      teParts.push(`${date}:${entries.length}:${entrySignatures.join(';')}`)
    }
    const dsParts: string[] = []
    for (const date of Object.keys(dailySummary).sort()) {
      dsParts.push(`${date}:${this.stableStringify(dailySummary[date] as unknown as JsonSerializable)}`)
    }
    return `te=${teParts.join('|')}|ds=${dsParts.join('|')}`
  }

  private hasMissingTerminalUpsert(
    snapshot: TaskLogSnapshot,
    records: ExecutionLogDeltaRecord[],
    latestIdentityOps: Map<string, IdentityOperationState> = new Map<string, IdentityOperationState>(),
  ): boolean {
    const terminals = this.collectTerminalUpserts(records)
    for (const terminal of terminals) {
      if (!this.shouldCheckTerminalUpsert(terminal, latestIdentityOps)) {
        continue
      }
      if (this.isTerminalUpsertMissing(snapshot, terminal)) {
        return true
      }
    }
    return false
  }

  private collectTerminalUpserts(records: ExecutionLogDeltaRecord[]): ExecutionLogDeltaRecord[] {
    const terminalsReversed: ExecutionLogDeltaRecord[] = []
    const seenIdentityKeys = new Set<string>()

    for (let i = records.length - 1; i >= 0; i--) {
      const candidate = records[i]
      const identity = this.getRecordIdentity(candidate)
      const identityKey = identity ? this.identityToKey(identity) : ''

      if (candidate.op === 'upsert') {
        if (identityKey && !seenIdentityKeys.has(identityKey)) {
          terminalsReversed.push(candidate)
        }
      }

      if (identityKey) {
        seenIdentityKeys.add(identityKey)
      }
    }
    terminalsReversed.reverse()
    return terminalsReversed
  }

  private filterReplayRecordsForFullReplay(
    records: ExecutionLogDeltaRecord[],
    latestIdentityOps: Map<string, IdentityOperationState>,
  ): ExecutionLogDeltaRecord[] {
    if (records.length === 0 || latestIdentityOps.size === 0) {
      return records
    }
    const filtered: ExecutionLogDeltaRecord[] = []
    for (const record of records) {
      if (record.op === 'upsert' && this.shouldSkipStaleReplayUpsert(record, latestIdentityOps)) {
        continue
      }
      filtered.push(record)
    }
    return filtered
  }

  /**
   * month-level replay 向けに、replay要求デバイスが触る identity/date のみを対象化し、
   * identity/date ごとに terminal レコードへ圧縮する。
   */
  private buildMonthReplayRecords(
    sourceRecords: Map<string, ExecutionLogDeltaRecord[]>,
    sources: DeltaSource[],
    replayRequests: Map<string, ReplayRequestReason>,
    latestIdentityOps: Map<string, IdentityOperationState>,
  ): ExecutionLogDeltaRecord[] {
    const replayDeviceIds = new Set(replayRequests.keys())
    if (replayDeviceIds.size === 0) {
      return []
    }

    const replayIdentityKeys = new Set<string>()
    const replaySummaryDates = new Set<string>()

    for (const source of sources) {
      if (!replayDeviceIds.has(source.deviceId)) {
        continue
      }
      const records = sourceRecords.get(source.filePath) ?? []
      for (const record of records) {
        const op = record.op ?? 'upsert'
        if (op === 'summary') {
          if (typeof record.dateKey === 'string' && record.dateKey.length > 0) {
            replaySummaryDates.add(record.dateKey)
          }
          continue
        }
        const identity = this.getRecordIdentity(record)
        if (!identity) {
          continue
        }
        replayIdentityKeys.add(this.identityToKey(identity))
      }
    }

    const latestByIdentity = new Map<string, ExecutionLogDeltaRecord>()
    const latestSummaryByDate = new Map<string, ExecutionLogDeltaRecord>()

    for (const records of sourceRecords.values()) {
      for (const record of records) {
        const op = record.op ?? 'upsert'
        if (op === 'summary') {
          const dateKey = typeof record.dateKey === 'string' ? record.dateKey : ''
          if (!dateKey || !replaySummaryDates.has(dateKey)) {
            continue
          }
          const current = latestSummaryByDate.get(dateKey)
          if (!current || this.compareEntryOrder(record, current) > 0) {
            latestSummaryByDate.set(dateKey, record)
          }
          continue
        }

        const identity = this.getRecordIdentity(record)
        if (!identity) {
          continue
        }
        const identityKey = this.identityToKey(identity)
        if (!replayIdentityKeys.has(identityKey)) {
          continue
        }
        const current = latestByIdentity.get(identityKey)
        if (!current) {
          latestByIdentity.set(identityKey, record)
          continue
        }
        const incomingOrder = this.toIdentityOperationState(record)
        const currentOrder = this.toIdentityOperationState(current)
        if (this.compareIdentityOperationOrder(incomingOrder, currentOrder) > 0) {
          latestByIdentity.set(identityKey, record)
        }
      }
    }

    const compacted = [
      ...latestByIdentity.values(),
      ...latestSummaryByDate.values(),
    ]
    const filtered = this.filterReplayRecordsForFullReplay(compacted, latestIdentityOps)
    filtered.sort((a, b) => this.compareEntryOrder(a, b))
    return filtered
  }

  private countReplayRequestedRecords(
    sources: DeltaSource[],
    sourceRecords: Map<string, ExecutionLogDeltaRecord[]>,
    replayRequests: Map<string, ReplayRequestReason>,
  ): number {
    let count = 0
    for (const source of sources) {
      if (!replayRequests.has(source.deviceId)) {
        continue
      }
      count += sourceRecords.get(source.filePath)?.length ?? 0
    }
    return count
  }

  private shouldSkipStaleReplayUpsert(
    record: ExecutionLogDeltaRecord,
    latestIdentityOps: Map<string, IdentityOperationState>,
  ): boolean {
    const identity = this.getRecordIdentity(record)
    if (!identity) {
      return false
    }
    const latest = latestIdentityOps.get(this.identityToKey(identity))
    if (!latest || latest.op !== 'delete') {
      return false
    }
    const candidate = this.toIdentityOperationState(record)
    // 指摘対応: 「deleteより古いupsert」のみ抑止し、同時刻競合は既存LWW挙動に委ねる
    if (latest.recordedAt === candidate.recordedAt) {
      return false
    }
    return this.compareIdentityOperationOrder(candidate, latest) < 0
  }

  private updateLatestIdentityOperations(
    target: Map<string, IdentityOperationState>,
    records: ExecutionLogDeltaRecord[],
  ): void {
    for (const record of records) {
      if (record.op !== 'upsert' && record.op !== 'delete') {
        continue
      }
      const identity = this.getRecordIdentity(record)
      if (!identity) {
        continue
      }
      const key = this.identityToKey(identity)
      const incoming = this.toIdentityOperationState(record)
      const current = target.get(key)
      if (!current || this.compareIdentityOperationOrder(incoming, current) > 0) {
        target.set(key, incoming)
      }
    }
  }

  private shouldCheckTerminalUpsert(
    terminal: ExecutionLogDeltaRecord,
    latestIdentityOps: Map<string, IdentityOperationState>,
  ): boolean {
    const identity = this.getRecordIdentity(terminal)
    if (!identity) {
      return false
    }
    const latest = latestIdentityOps.get(this.identityToKey(identity))
    if (!latest) {
      return true
    }
    if (latest.op === 'delete') {
      return false
    }
    const terminalState = this.toIdentityOperationState(terminal)
    return this.compareIdentityOperationOrder(terminalState, latest) >= 0
  }

  private identityToKey(identity: RecordIdentity): string {
    return `${identity.kind}:${identity.value}`
  }

  private toIdentityOperationState(record: ExecutionLogDeltaRecord): IdentityOperationState {
    return {
      op: record.op === 'delete' ? 'delete' : 'upsert',
      recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      entryId: typeof record.entryId === 'string' ? record.entryId : '',
    }
  }

  private compareIdentityOperationOrder(a: IdentityOperationState, b: IdentityOperationState): number {
    const order = this.compareEntryOrder(
      { recordedAt: a.recordedAt, deviceId: a.deviceId, entryId: a.entryId },
      { recordedAt: b.recordedAt, deviceId: b.deviceId, entryId: b.entryId },
    )
    if (order !== 0) {
      return order
    }
    if (a.op === b.op) {
      return 0
    }
    // 同順位ではdeleteを優先して resurrection を防ぐ
    return a.op === 'delete' ? 1 : -1
  }

  private getRecordIdentity(
    record: ExecutionLogDeltaRecord,
  ): RecordIdentity | null {
    const payload = record.payload as Partial<TaskLogEntry> | undefined
    const instanceId = this.normalizeInstanceId(payload?.instanceId)
    if (instanceId) {
      return { kind: 'instanceId', value: instanceId }
    }
    return null
  }

  private collectIdentityKeysFromRecords(records: ExecutionLogDeltaRecord[]): Set<string> {
    const keys = new Set<string>()
    for (const record of records) {
      const identity = this.getRecordIdentity(record)
      if (!identity) {
        continue
      }
      keys.add(this.identityToKey(identity))
    }
    return keys
  }

  private recordsTouchAnyIdentity(records: ExecutionLogDeltaRecord[], identityKeys: Set<string>): boolean {
    if (identityKeys.size === 0) {
      return false
    }
    for (const record of records) {
      const identity = this.getRecordIdentity(record)
      if (!identity) {
        continue
      }
      if (identityKeys.has(this.identityToKey(identity))) {
        return true
      }
    }
    return false
  }

  private recordSupersedesIdentity(
    record: ExecutionLogDeltaRecord,
    identity: RecordIdentity,
  ): boolean {
    const payload = record.payload as Partial<TaskLogEntry> | undefined
    const instanceId = this.normalizeInstanceId(payload?.instanceId)

    if (record.op === 'upsert') {
      return instanceId === identity.value
    }
    if (record.op === 'delete') {
      return instanceId === identity.value
    }
    return false
  }

  private isTerminalUpsertMissing(
    snapshot: TaskLogSnapshot,
    record: ExecutionLogDeltaRecord,
  ): boolean {
    const payload = record.payload as Partial<TaskLogEntry> | undefined
    if (!payload || typeof record.dateKey !== 'string') {
      return false
    }
    const dateEntriesRaw = snapshot.taskExecutions[record.dateKey]
    const dateEntries = Array.isArray(dateEntriesRaw) ? dateEntriesRaw : []
    const candidate: TaskLogEntry = {
      ...payload,
      entryId: record.entryId,
      deviceId: record.deviceId,
      recordedAt: record.recordedAt,
    }
    if (this.findMatchingEntryIndex(dateEntries, candidate) >= 0) {
      return false
    }

    const identity = this.getRecordIdentity(record)
    if (!identity) {
      return false
    }
    const candidateRecordedAt = typeof record.recordedAt === 'string' ? record.recordedAt : ''
    const supersededByNewerEntry = dateEntries.some((entry) => {
      if (!entry) return false
      if (this.normalizeInstanceId(entry.instanceId) !== identity.value) {
        return false
      }
      const existingRecordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : ''
      return existingRecordedAt > candidateRecordedAt
    })
    if (supersededByNewerEntry) {
      return false
    }
    return true
  }

  private normalizeInstanceId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * 再帰stable stringify: 全階層でキーをソートして決定的なJSON文字列を生成。
   */
  private stableStringify(value: JsonSerializable | undefined): string {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
      return '[' + value.map(v => v === undefined ? 'null' : this.stableStringify(v)).join(',') + ']'
    }
    const obj = value as Record<string, JsonSerializable | undefined>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const k of keys) {
      const v = obj[k]
      if (v === undefined) continue
      parts.push(JSON.stringify(k) + ':' + this.stableStringify(v))
    }
    return '{' + parts.join(',') + '}'
  }

  private hashFnv1a(seed: number, text: string): number {
    let hash = seed >>> 0
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }

  private hashDjb2(seed: number, text: string): number {
    let hash = seed >>> 0
    for (let i = 0; i < text.length; i++) {
      hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0
    }
    return hash >>> 0
  }

  private toHex32(value: number): string {
    return (value >>> 0).toString(16).padStart(8, '0')
  }

  /** device単位でCSRマップをマージ（大きい方を採用） */
  private mergeDeviceRevisionMap(
    a?: Record<string, number>,
    b?: Record<string, number>,
  ): Record<string, number> | undefined {
    if (!a && !b) return undefined
    const merged: Record<string, number> = {}
    if (a) {
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'number') merged[k] = v
      }
    }
    if (b) {
      for (const [k, v] of Object.entries(b)) {
        if (typeof v === 'number') {
          if (merged[k] === undefined || v > merged[k]) merged[k] = v
        }
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined
  }

  private finalizeMeta(snapshot: TaskLogSnapshot): void {
    const target = this.ensureMeta(snapshot.meta)
    snapshot.meta = target
    // revisionは書き込み時に更新されるため、ここでは更新しない
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

  /**
   * 競合検出付きスナップショット永続化
   */
  private async persistSnapshotWithConflictDetection(context: MonthContext): Promise<void> {
    const snapshot = context.snapshot
    for (const dateKey of context.mutatedDates) {
      this.recomputeSummaryForDate(snapshot, dateKey)
    }

    await this.snapshotWriter.writeWithConflictDetection(
      context.monthKey,
      snapshot,
      context.expectedRevision,
      {
        existingFile: context.file,
        previousRaw: context.previousRaw,
      }
    )
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

  private async writeRecordsForSnapshot(snapshot: TaskLogSnapshot): Promise<void> {
    const meta = this.ensureMeta(snapshot.meta)
    const canonicalRevision = meta.revision ?? 0
    const allDateKeys = new Set([
      ...Object.keys(snapshot.taskExecutions),
      ...Object.keys(snapshot.dailySummary),
    ])
    for (const dateKey of allDateKeys) {
      const entries = snapshot.taskExecutions[dateKey] ?? []
      await this.recordsWriter.writeDay({
        dateKey,
        entries,
        summary: snapshot.dailySummary[dateKey],
        canonicalRevision,
        snapshotMeta: meta,
      })
    }
  }

  /**
   * deltaから再構築（JSON破損時の復旧）
   *
   * 通常のdeltaファイルに加え、アーカイブ済みdeltaも読み込んで完全な復旧を行う
   */
  private async rebuildFromDeltas(monthKey: string, sources: DeltaSource[]): Promise<void> {
    console.warn(`[LogReconciler] Rebuilding snapshot from deltas: ${monthKey}`)

    // 破損ファイルをバックアップ
    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const adapter = this.plugin.app.vault.adapter as {
      rename?: (from: string, to: string) => Promise<void>
      read?: (path: string) => Promise<string>
      exists?: (path: string) => Promise<boolean>
    }

    if (adapter?.rename) {
      const backupPath = `${logPath}.corrupted.${Date.now()}`
      await adapter.rename(logPath, backupPath).catch(() => {})
    }

    // 空のスナップショットから再構築
    const freshSnapshot: TaskLogSnapshot = createEmptyTaskLogSnapshot()
    freshSnapshot.meta = { revision: 0, processedCursor: {} }

    // 対象月のsourcesをフィルタリング
    const monthSources = sources.filter((s) => s.monthKey === monthKey)

    // 各デバイスのdeltaを収集（アーカイブ + 通常）
    const processedDevices = new Set<string>()
    const cursorByDevice = new Map<string, number>()
    const allRecords: ExecutionLogDeltaRecord[] = []

    for (const source of monthSources) {
      processedDevices.add(source.deviceId)
      const archivePath = source.filePath.replace('.jsonl', '.archived.jsonl')
      const archiveRecords = await this.readDeltaRecords(archivePath)
      const records = await this.readDeltaRecords(source.filePath)
      if (archiveRecords.length > 0) {
        allRecords.push(...archiveRecords)
      }
      if (records.length > 0) {
        allRecords.push(...records)
      }
      cursorByDevice.set(source.deviceId, records.length)
    }

    // アーカイブのみのソースを探索（通常ファイルがないデバイス用）
    const archivedOnlySources = await this.collectArchivedOnlySources(monthKey)
    for (const archivedSource of archivedOnlySources) {
      if (processedDevices.has(archivedSource.deviceId)) continue
      const archiveRecords = await this.readDeltaRecords(archivedSource.filePath)
      if (archiveRecords.length > 0) {
        allRecords.push(...archiveRecords)
      }
      cursorByDevice.set(archivedSource.deviceId, 0)
    }

    // recordedAt順で適用（LWW順序を保証）
    const sortedRecords = [...allRecords].sort((a, b) => {
      const timeA = a.recordedAt ?? ''
      const timeB = b.recordedAt ?? ''
      if (timeA !== timeB) {
        return timeA.localeCompare(timeB)
      }
      const deviceA = a.deviceId ?? ''
      const deviceB = b.deviceId ?? ''
      if (deviceA !== deviceB) {
        return deviceA.localeCompare(deviceB)
      }
      const entryA = a.entryId ?? ''
      const entryB = b.entryId ?? ''
      return entryA.localeCompare(entryB)
    })
    this.applyRecordsToSnapshot(sortedRecords, freshSnapshot, new Set<string>(), { preferNewer: true })

    for (const [deviceId, cursor] of cursorByDevice) {
      freshSnapshot.meta.processedCursor![deviceId] = cursor
    }

    // dailySummaryを再計算
    for (const dateKey of Object.keys(freshSnapshot.taskExecutions)) {
      this.recomputeSummaryForDate(freshSnapshot, dateKey)
    }

    // 保存（新規ファイルなので競合検出不要）
    await this.snapshotWriter.write(monthKey, freshSnapshot, { forceBackup: false })
    this.clearNoOpCacheForMonth(monthKey)

    // recordsも更新（再構築後のスナップショットと整合性を取る）
    // P2-summary-only-rebuild対応: taskExecutionsとdailySummaryの両方のキーを結合
    // op: 'summary' のdeltaはdailySummaryのみを更新するため、taskExecutionsにない日付も含める
    const allDateKeys = new Set([
      ...Object.keys(freshSnapshot.taskExecutions),
      ...Object.keys(freshSnapshot.dailySummary),
    ])
    await this.writeRecordsForSnapshot(freshSnapshot)

    console.warn(`[LogReconciler] Rebuilt snapshot with ${allDateKeys.size} days (${Object.keys(freshSnapshot.taskExecutions).length} with tasks, ${Object.keys(freshSnapshot.dailySummary).length} with summaries)`)
  }

  /**
   * アーカイブ済みdeltaファイルを探索
   * （通常ファイルがない場合でもアーカイブのみ存在する可能性がある）
   *
   * Sync直後はVaultキャッシュが未更新の可能性があるため、
   * adapter.listも併用して確実にファイルを検出する
   */
  private async collectArchivedOnlySources(monthKey: string): Promise<DeltaSource[]> {
    const aggregated = new Map<string, DeltaSource>()

    for (const inboxPath of this.getDeltaInboxPaths()) {
      // 1. Vaultキャッシュから収集
      const fromVault = this.collectArchivedFromVaultTree(inboxPath, monthKey)
      for (const source of fromVault) {
        if (!aggregated.has(source.filePath)) {
          aggregated.set(source.filePath, source)
        }
      }

      // 2. adapter.listから収集（Sync直後対応）
      const fromAdapter = await this.collectArchivedFromAdapter(inboxPath, monthKey)
      for (const source of fromAdapter) {
        if (!aggregated.has(source.filePath)) {
          aggregated.set(source.filePath, source)
        }
      }
    }

    return Array.from(aggregated.values())
  }

  private collectArchivedFromVaultTree(inboxPath: string, monthKey: string): DeltaSource[] {
    const archivedSources: DeltaSource[] = []
    const root = this.plugin.app.vault.getAbstractFileByPath(inboxPath)
    if (!root || !(root instanceof TFolder)) return archivedSources

    for (const deviceFolder of root.children) {
      if (!(deviceFolder instanceof TFolder)) continue
      const deviceId = deviceFolder.name

      for (const child of deviceFolder.children) {
        if (!(child instanceof TFile)) continue
        // アーカイブファイル（例: 2026-02.archived.jsonl）を探す
        if (!child.path.endsWith('.archived.jsonl')) continue

        // basename から monthKey を抽出（例: "2026-02.archived" → "2026-02"）
        const archivedMonthKey = child.basename.replace('.archived', '')
        if (archivedMonthKey !== monthKey) continue

        archivedSources.push({
          deviceId,
          monthKey: archivedMonthKey,
          filePath: child.path,
        })
      }
    }

    return archivedSources
  }

  private async collectArchivedFromAdapter(inboxPath: string, monthKey: string): Promise<DeltaSource[]> {
    const adapter = this.plugin.app.vault.adapter as { list?: (path: string) => Promise<{ files: string[]; folders: string[] }> }
    if (!adapter || typeof adapter.list !== 'function') {
      return []
    }

    const archivedSources: DeltaSource[] = []
    const expectedSuffix = `${monthKey}.archived.jsonl`

    try {
      const listing = await adapter.list(inboxPath)
      for (const deviceFolder of listing.folders ?? []) {
        const deviceId = deviceFolder.split('/').pop() ?? deviceFolder
        let files: string[] = []
        try {
          const inner = await adapter.list(deviceFolder)
          files = inner.files ?? []
        } catch {
          continue
        }

        for (const filePath of files) {
          if (!filePath.endsWith('.archived.jsonl')) continue
          if (!filePath.endsWith(expectedSuffix)) continue

          archivedSources.push({
            deviceId,
            monthKey,
            filePath,
          })
        }
      }
    } catch {
      // adapter.listが失敗した場合は空配列を返す
    }

    return archivedSources
  }

  /**
   * Legacy snapshotを新形式に移行
   *
   * 動作:
   * 1. 既存スナップショットのデータを保持
   * 2. meta/processedCursorを補完
   * 3. 既存データとdeltaをマージ（重複排除）
   * 4. 新形式で保存
   */
  private async migrateLegacySnapshot(
    monthKey: string,
    legacySnapshot: TaskLogSnapshot,
    sources: DeltaSource[]
  ): Promise<void> {
    console.warn(`[LogReconciler] Migrating legacy snapshot: ${monthKey}`)

    const logBase = this.plugin.pathManager.getLogDataPath()
    const logPath = normalizePath(`${logBase}/${monthKey}-tasks.json`)
    const adapter = this.plugin.app.vault.adapter as {
      rename?: (from: string, to: string) => Promise<void>
      read?: (path: string) => Promise<string>
    }

    // 現在のファイルを再読込して新形式かどうか確認
    const existingFile = this.plugin.app.vault.getAbstractFileByPath(logPath)
    if (existingFile instanceof TFile) {
      try {
        const currentContent = await this.plugin.app.vault.read(existingFile)
        const currentSnapshot = parseTaskLogSnapshot(currentContent)

        // rawデータでmetaフィールドの有無を判定（parseTaskLogSnapshotはmeta無しでもrevision=0を補完するため）
        let hasMetaInRaw = false
        try {
          const rawParsed = JSON.parse(currentContent) as { meta?: unknown }
          hasMetaInRaw = rawParsed.meta !== undefined && rawParsed.meta !== null
        } catch {
          // parse失敗は無視
        }

        const currentRevision = currentSnapshot.meta?.revision
        if (hasMetaInRaw && typeof currentRevision === 'number' && currentRevision >= 0) {
          // 新形式が既に存在 → renameせずにマージして終了
          console.warn(`[LogReconciler] Another device already migrated (rev=${currentRevision}), merging...`)
          const mergedSnapshot = this.createMergedSnapshot(legacySnapshot, currentSnapshot)
          await this.writeMigrationSnapshotWithRetry(monthKey, mergedSnapshot, currentRevision)
          return
        }
        // 現在もlegacy → 最新の内容をベースに使用
        legacySnapshot = currentSnapshot
      } catch {
        console.warn(`[LogReconciler] Failed to read current snapshot, using passed snapshot`)
      }
    }

    // 旧スナップショットをバックアップ
    if (adapter?.rename) {
      const backupPath = logPath.replace('.json', `.legacy.${Date.now()}.json`)
      await adapter.rename(logPath, backupPath).catch(() => {})
      console.warn(`[LogReconciler] Backed up legacy snapshot to: ${backupPath}`)
    }

    // 既存データを保持
    const migratedSnapshot: TaskLogSnapshot = {
      taskExecutions: { ...legacySnapshot.taskExecutions },
      dailySummary: { ...legacySnapshot.dailySummary },
      meta: {
        revision: 0,  // 新形式の初期値
        processedCursor: {}
      }
    }

    // 両方のinboxをスキャン（preferred + legacy）
    // ファイルパスで重複排除（sourcesとcollectSourcesFromAdapterで同じファイルを二重読み込みしない）
    const inboxPaths = this.getDeltaInboxPaths()
    const allRecordsByDevice = new Map<string, ExecutionLogDeltaRecord[]>()
    const processedFilePaths = new Set<string>()
    const processedArchivedPaths = new Set<string>()

    for (const inboxPath of inboxPaths) {
      const sourcesFromInbox = await this.collectSourcesFromAdapter(inboxPath)
      for (const source of sourcesFromInbox) {
        if (source.monthKey !== monthKey) continue
        if (processedFilePaths.has(source.filePath)) continue
        processedFilePaths.add(source.filePath)

        // 通常ファイルとアーカイブ両方を読み込み
        const records = await this.readDeltaRecords(source.filePath)
        const archivedPath = source.filePath.replace('.jsonl', '.archived.jsonl')
        const archivedRecords = await this.readDeltaRecords(archivedPath)
        if (archivedRecords.length > 0) {
          processedArchivedPaths.add(archivedPath)
        }

        const existing = allRecordsByDevice.get(source.deviceId) ?? []
        allRecordsByDevice.set(source.deviceId, [...existing, ...records, ...archivedRecords])
      }

      // アーカイブ専用ファイルも収集（通常の.jsonlが削除され.archived.jsonlのみ残っている場合）
      // Reviewer Issue P2-archived-only対応
      await this.collectArchivedOnlyFiles(
        inboxPath,
        monthKey,
        processedArchivedPaths,
        allRecordsByDevice
      )
    }

    // passedされたsourcesも処理（重複排除）
    for (const source of sources) {
      if (processedFilePaths.has(source.filePath)) continue
      processedFilePaths.add(source.filePath)

      const records = await this.readDeltaRecords(source.filePath)
      const archivedPath = source.filePath.replace('.jsonl', '.archived.jsonl')
      const archivedRecords = await this.readDeltaRecords(archivedPath)
      if (archivedRecords.length > 0) {
        processedArchivedPaths.add(archivedPath)
      }

      const existing = allRecordsByDevice.get(source.deviceId) ?? []
      allRecordsByDevice.set(source.deviceId, [...existing, ...records, ...archivedRecords])
    }

    // 全deltaを適用（デバイス横断でrecordedAt順にソートしてLWWを保証）
    const allRecords: ExecutionLogDeltaRecord[] = []
    for (const records of allRecordsByDevice.values()) {
      if (records.length > 0) {
        allRecords.push(...records)
      }
    }
    const sortedAllRecords = [...allRecords].sort((a, b) => {
      const timeA = a.recordedAt ?? ''
      const timeB = b.recordedAt ?? ''
      if (timeA !== timeB) {
        return timeA.localeCompare(timeB)
      }
      const deviceA = a.deviceId ?? ''
      const deviceB = b.deviceId ?? ''
      if (deviceA !== deviceB) {
        return deviceA.localeCompare(deviceB)
      }
      const entryA = a.entryId ?? ''
      const entryB = b.entryId ?? ''
      return entryA.localeCompare(entryB)
    })
    this.applyRecordsToSnapshot(sortedAllRecords, migratedSnapshot, new Set<string>(), { preferNewer: true })

    for (const deviceId of allRecordsByDevice.keys()) {
      // cursorは通常ファイルの行数のみを使用
      const sourceForDevice = sources.find(s => s.deviceId === deviceId)
      if (sourceForDevice) {
        const normalRecords = await this.readDeltaRecords(sourceForDevice.filePath)
        if (normalRecords.length > 0) {
          const existingCursor = migratedSnapshot.meta!.processedCursor![deviceId] ?? 0
          migratedSnapshot.meta!.processedCursor![deviceId] = Math.max(existingCursor, normalRecords.length)
        }
      }
    }

    // dailySummaryを再計算
    for (const dateKey of Object.keys(migratedSnapshot.taskExecutions)) {
      this.recomputeSummaryForDate(migratedSnapshot, dateKey)
    }

    // 書き込み前に現在のファイルを再確認（同時移行対策）
    const existingFileCheck = this.plugin.app.vault.getAbstractFileByPath(logPath)
    if (existingFileCheck instanceof TFile) {
      try {
        const currentContent = await this.plugin.app.vault.read(existingFileCheck)
        const currentSnapshot = parseTaskLogSnapshot(currentContent)

        // rawデータでmetaフィールドの有無を判定（parseTaskLogSnapshotはmeta無しでもrevision=0を補完するため）
        let hasMetaInRaw = false
        try {
          const rawParsed = JSON.parse(currentContent) as { meta?: unknown }
          hasMetaInRaw = rawParsed.meta !== undefined && rawParsed.meta !== null
        } catch {
          // parse失敗は無視
        }

        const currentRevision = currentSnapshot.meta?.revision
        if (hasMetaInRaw && typeof currentRevision === 'number' && currentRevision >= 0) {
          // 新形式が既に存在 → マージしてからwrite
          console.warn(`[LogReconciler] Another device already migrated (actual meta), merging...`)
          this.mergeSnapshots(migratedSnapshot, currentSnapshot)
          migratedSnapshot.meta!.revision = currentRevision
          await this.writeMigrationSnapshotWithRetry(monthKey, migratedSnapshot, currentRevision)
          return
        }
      } catch {
        console.warn(`[LogReconciler] Failed to read current snapshot during migration, overwriting`)
      }
    }

    // 新規ファイルとして書き込み（旧ファイルは削除済みなので競合なし）
    await this.snapshotWriter.write(monthKey, migratedSnapshot, { forceBackup: true })
    this.clearNoOpCacheForMonth(monthKey)
    await this.writeRecordsForSnapshot(migratedSnapshot)

    console.warn(`[LogReconciler] Migrated legacy snapshot: ${monthKey} with ${Object.keys(migratedSnapshot.taskExecutions).length} days`)
  }

  private async writeMigrationSnapshotWithRetry(
    monthKey: string,
    snapshot: TaskLogSnapshot,
    expectedRevision: number,
  ): Promise<boolean> {
    let retries = 0
    let pendingSnapshot = snapshot
    let pendingRevision = expectedRevision

    while (retries <= MAX_RETRIES) {
      try {
        await this.snapshotWriter.writeWithConflictDetection(monthKey, pendingSnapshot, pendingRevision)
        this.clearNoOpCacheForMonth(monthKey)
        await this.writeRecordsForSnapshot(pendingSnapshot)
        return true
      } catch (error) {
        if (!(error instanceof SnapshotConflictError)) {
          throw error
        }

        retries += 1
        console.warn(`[LogReconciler] Conflict retry ${retries}/${MAX_RETRIES} during legacy migration for ${monthKey}`)
        if (retries >= MAX_RETRIES) {
          console.error('[LogReconciler] Max retries exceeded during legacy migration, deferring to next reconcile')
          return false
        }

        const latestSnapshot = error.currentSnapshot
        pendingSnapshot = this.createMergedSnapshot(pendingSnapshot, latestSnapshot)
        pendingRevision = latestSnapshot.meta?.revision ?? pendingRevision

        const delay = Math.min(1000 * Math.pow(2, retries) + this.deps.randomFn() * 500, 10000)
        await this.deps.sleepFn(delay)
      }
    }

    return false
  }

  /**
   * 2つのスナップショットをマージ（新規作成）
   *
   * ルール:
   * 1. taskExecutions: 両方のエントリをマージ（重複はinstanceIdで除去）
   * 2. dailySummary: マージ後に再計算
   * 3. meta.revision: 新形式側（currentSnapshot）のrevisionを使用
   * 4. meta.processedCursor: 各deviceIdについてmax値を使用（後退防止）
   */
  private createMergedSnapshot(
    legacySnapshot: TaskLogSnapshot,
    currentSnapshot: TaskLogSnapshot
  ): TaskLogSnapshot {
    const merged: TaskLogSnapshot = {
      taskExecutions: {},
      dailySummary: {},
      meta: {
        revision: currentSnapshot.meta?.revision ?? 0,
        processedCursor: {},
        cursorSnapshotRevision: this.mergeDeviceRevisionMap(
          legacySnapshot.meta?.cursorSnapshotRevision,
          currentSnapshot.meta?.cursorSnapshotRevision,
        ),
      }
    }

    // taskExecutionsをマージ（legacyを先にコピーし、currentで上書き）
    for (const [dateKey, entries] of Object.entries(legacySnapshot.taskExecutions ?? {})) {
      merged.taskExecutions[dateKey] = [...entries]
    }
    for (const [dateKey, entries] of Object.entries(currentSnapshot.taskExecutions ?? {})) {
      const existing = merged.taskExecutions[dateKey] ?? []
      for (const entry of entries) {
        // 同一エントリがある場合は上書き（currentが最新）
        const existingIdx = this.findMatchingEntryIndex(existing, entry)
        if (existingIdx >= 0) {
          existing[existingIdx] = entry
        } else {
          existing.push(entry)
        }
      }
      merged.taskExecutions[dateKey] = existing
    }

    // processedCursorは各deviceIdでmax（後退防止）
    const allDeviceIds = new Set([
      ...Object.keys(legacySnapshot.meta?.processedCursor ?? {}),
      ...Object.keys(currentSnapshot.meta?.processedCursor ?? {})
    ])
    for (const deviceId of allDeviceIds) {
      const legacyCursor = legacySnapshot.meta?.processedCursor?.[deviceId] ?? 0
      const currentCursor = currentSnapshot.meta?.processedCursor?.[deviceId] ?? 0
      merged.meta!.processedCursor![deviceId] = Math.max(legacyCursor, currentCursor)
    }

    // dailySummaryをマージ（LWWで新しいsummaryを優先）
    const allSummaryDates = new Set([
      ...Object.keys(legacySnapshot.dailySummary ?? {}),
      ...Object.keys(currentSnapshot.dailySummary ?? {})
    ])
    for (const dateKey of allSummaryDates) {
      const legacySummary = legacySnapshot.dailySummary?.[dateKey]
      const currentSummary = currentSnapshot.dailySummary?.[dateKey]
      if (legacySummary && currentSummary) {
        const legacyMeta = this.readSummaryMeta(legacySummary)
        const currentMeta = this.readSummaryMeta(currentSummary)
        if (this.isIncomingSummaryNewer(legacyMeta, currentMeta)) {
          merged.dailySummary[dateKey] = { ...currentSummary }
        } else if (this.isIncomingSummaryNewer(currentMeta, legacyMeta)) {
          merged.dailySummary[dateKey] = { ...legacySummary }
        } else {
          // 競合情報が無い/同値の場合はcurrentを優先
          merged.dailySummary[dateKey] = { ...currentSummary }
        }
        continue
      }
      if (currentSummary) {
        merged.dailySummary[dateKey] = { ...currentSummary }
      } else if (legacySummary) {
        merged.dailySummary[dateKey] = { ...legacySummary }
      }
    }

    // dailySummaryを再計算（taskExecutionsの日付）
    for (const dateKey of Object.keys(merged.taskExecutions)) {
      this.recomputeSummaryForDate(merged, dateKey)
    }

    return merged
  }

  /**
   * mergeSnapshotsは既存のsnapshotに別のsnapshotをマージする（破壊的）
   */
  private mergeSnapshots(target: TaskLogSnapshot, source: TaskLogSnapshot): void {
    const merged = this.createMergedSnapshot(target, source)
    target.taskExecutions = merged.taskExecutions
    target.dailySummary = merged.dailySummary
    target.meta!.processedCursor = merged.meta!.processedCursor
    // cursorSnapshotRevision をdevice単位でマージ
    if (merged.meta?.cursorSnapshotRevision) {
      if (!target.meta!.cursorSnapshotRevision) {
        target.meta!.cursorSnapshotRevision = {}
      }
      for (const [deviceId, rev] of Object.entries(merged.meta.cursorSnapshotRevision)) {
        const existing = target.meta!.cursorSnapshotRevision[deviceId]
        if (typeof rev === 'number' && (existing === undefined || rev > existing)) {
          target.meta!.cursorSnapshotRevision[deviceId] = rev
        }
      }
    }
    // revisionはcaller側で設定
  }
}
