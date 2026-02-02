import { normalizePath, TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import type { TaskLogEntry, TaskLogSnapshot, TaskLogSnapshotMeta } from '../../../types/ExecutionLog'
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

/**
 * LogReconciler依存関係インターフェース（DI対応）
 */
export interface LogReconcilerDeps {
  snapshotWriter: LogSnapshotWriter
  recordsWriter: RecordsWriter
  sleepFn: (ms: number) => Promise<void>
  randomFn: () => number
}

const MAX_RETRIES = 3

export class LogReconciler {
  private readonly snapshotWriter: LogSnapshotWriter
  private readonly recordsWriter: RecordsWriter
  private readonly backupPruner: BackupPruner
  private lastBackupPrune = 0
  private readonly deps: LogReconcilerDeps

  // Promiseチェーン方式のミューテックス: 各monthKeyに対する最後のPromiseを保持
  private lockChains = new Map<string, Promise<void>>()

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
    // 現在のチェーン末尾を取得（なければ即座に解決するPromise）
    const currentChain = this.lockChains.get(monthKey) ?? Promise.resolve()

    // 結果を外部に公開するためのPromise
    let resolveResult!: (value: T) => void
    let rejectResult!: (reason: unknown) => void
    const resultPromise = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    // 新しいチェーンを作成：既存チェーン完了後に自分のタスクを実行
    // P2-lock-chain-reject対応: 先行の失敗を握りつぶし、後続タスクが必ず実行されるようにする
    const newChain = currentChain
      .catch(() => {})  // 先行タスクの失敗を握りつぶす
      .then(() => fn())
      .then(
        (result) => { resolveResult(result) },
        (error) => { rejectResult(error) }
      )
      .finally(() => {
        // チェーンが自分で終わっていたら削除（メモリリーク防止）
        if (this.lockChains.get(monthKey) === newChain) {
          this.lockChains.delete(monthKey)
        }
      })

    // 新しいチェーン末尾をMapに保存（次の呼び出しはこれにチェーン）
    this.lockChains.set(monthKey, newChain)

    return resultPromise
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
    const processedCursor = meta.processedCursor!

    // pendingCursorsに一時保存（書き込み成功時のみ反映）
    const pendingCursors = new Map<string, number>()
    let processedEntries = 0
    const affectedDates = context.mutatedDates

    for (const source of sources) {
      const records = await this.readDeltaRecords(source.filePath)
      if (records.length === 0) {
        if ((processedCursor?.[source.deviceId] ?? 0) !== 0) {
          pendingCursors.set(source.deviceId, 0)
          context.metaMutated = true
        }
        continue
      }
      let startIndex = processedCursor?.[source.deviceId] ?? 0
      let cursorReset = false
      if (startIndex > records.length) {
        console.warn('[LogReconciler] Delta cursor exceeds file length, resetting', source.deviceId, source.monthKey)
        startIndex = 0
        pendingCursors.set(source.deviceId, 0)
        context.metaMutated = true
        cursorReset = true
      }
      if (startIndex >= records.length && !cursorReset) {
        if (processedCursor[source.deviceId] !== records.length) {
          pendingCursors.set(source.deviceId, records.length)
          context.metaMutated = true
        }
        continue
      }
      const sliceStart = cursorReset ? 0 : startIndex
      const newRecords = records.slice(sliceStart)
      const applied = this.applyRecordsToSnapshot(newRecords, context.snapshot, affectedDates)
      processedEntries += applied
      pendingCursors.set(source.deviceId, records.length)
      context.metaMutated = context.metaMutated || applied > 0 || records.length !== startIndex
    }

    // P1-mixed-month対応: 通常sourcesが存在する月でも、archived-onlyのデバイスからdeltaを取り込む
    // シナリオ: デバイスAは通常.jsonl、デバイスBは.archived.jsonlのみの場合、
    // デバイスBのログが欠落しないようにする
    // P2-missing-snapshot-archived対応: スナップショット欠損時は全デバイスのarchivedも処理
    const snapshotMissing = context.file === null
    const archivedApplied = await this.applyArchivedOnlyDeltas(monthKey, sources, context.snapshot, affectedDates, snapshotMissing)
    if (archivedApplied > 0) {
      processedEntries += archivedApplied
      context.metaMutated = true
    }

    if (processedEntries > 0 || context.metaMutated) {
      // processedCursorを反映してから書き込み
      for (const [deviceId, cursor] of pendingCursors) {
        meta.processedCursor![deviceId] = cursor
      }

      this.finalizeMeta(context.snapshot)
      await this.persistSnapshotWithConflictDetection(context)
      await this.writeRecordEntries(context)
    }

    return { processedEntries }
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
    options?: { preferNewer?: boolean },
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
        if (options?.preferNewer && !this.isIncomingEntryNewer(entries[idx], normalizedEntry)) {
          continue
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
    const targetInstanceId = entry.instanceId
    const targetTaskId = typeof entry.taskId === 'string' ? entry.taskId : undefined

    // instanceIdでマッチングを試みる
    if (targetInstanceId) {
      const idx = entries.findIndex((existing) => existing?.instanceId === targetInstanceId)
      if (idx >= 0) {
        return idx
      }

      // instanceIdマッチング失敗で、instanceIdがないエントリをtaskIdでフォールバック
      // （レガシーエントリへの後方互換性）- 最初の1件のみ削除
      if (targetTaskId) {
        const legacyIdx = entries.findIndex(
          (existing) => !existing?.instanceId && existing?.taskId === targetTaskId
        )
        if (legacyIdx >= 0) {
          return legacyIdx
        }
      }
      // マッチしなかった場合は削除しない
      return -1
    }

    // instanceIdがない場合は、taskIdでフォールバック（後方互換性）- 最初の1件のみ削除
    if (targetTaskId) {
      return entries.findIndex((existing) => existing?.taskId === targetTaskId)
    }

    return -1
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
        processedCursor: {}
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
    // revisionはcaller側で設定
  }
}
