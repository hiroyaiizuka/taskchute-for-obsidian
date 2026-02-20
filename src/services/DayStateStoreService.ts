import { DayState, DeletedInstance, HiddenRoutine, DayStateServiceAPI } from '../types';
import { renamePathsInDayState } from './dayState/pathRename';
import { getEffectiveDeletedAt, isDeleted as isDeletedEntry, isHidden as isHiddenEntry, isLegacyDeletionEntry } from './dayState/conflictResolver';

export interface DayStateStoreServiceOptions {
  dayStateService: DayStateServiceAPI;
  getCurrentDateString: () => string;
  parseDateString: (dateKey: string) => Date;
  cache?: Map<string, DayState>;
}

export class DayStateStoreService {
  private cache: Map<string, DayState>;
  private currentKey: string | null = null;
  private currentState: DayState | null = null;

  /** Reference-counted write barrier depth. persist/persistAsync are suppressed while > 0. */
  private barrierDepth = 0;
  /** Month keys that have pending writes accumulated during barrier. */
  private pendingWriteMonthKeys = new Set<string>();
  /** Date keys that have pending writes during barrier (to collect DayState from cache). */
  private pendingWriteDateKeys = new Set<string>();
  /** Snapshots captured at persist-time during barrier to survive later cache clear/reload. */
  private pendingWriteSnapshots = new Map<string, DayState>();

  constructor(private readonly options: DayStateStoreServiceOptions) {
    this.cache = options.cache ?? new Map<string, DayState>();
  }

  async ensure(dateKey?: string): Promise<DayState> {
    const key = dateKey ?? this.options.getCurrentDateString();
    const cached = this.cache.get(key);
    if (cached) {
      return this.setCurrent(key, cached);
    }

    const loaded = await this.options.dayStateService.loadDay(this.options.parseDateString(key));
    const normalized = this.normalizeState(loaded);
    this.cache.set(key, normalized);
    return this.setCurrent(key, normalized);
  }

  snapshot(dateKey: string): DayState | null {
    return this.cache.get(dateKey) ?? null;
  }

  getCurrent(): DayState {
    if (this.currentState) {
      return this.currentState;
    }
    const key = this.options.getCurrentDateString();
    const cached = this.cache.get(key);
    if (cached) {
      return this.setCurrent(key, cached);
    }
    const emptyState = this.createEmptyState();
    this.cache.set(key, emptyState);
    return this.setCurrent(key, emptyState);
  }

  clear(dateKey?: string): void {
    if (dateKey) {
      this.cache.delete(dateKey);
      if (this.currentKey === dateKey) {
        this.currentKey = null;
        this.currentState = null;
      }
      if (typeof this.options.dayStateService.clearCacheForDate === 'function') {
        void this.options.dayStateService.clearCacheForDate(dateKey);
      }
      return;
    }
    this.cache.clear();
    this.currentKey = null;
    this.currentState = null;
    // Also clear the persistence layer's month-level cache to pick up external changes
    if (typeof this.options.dayStateService.clearCache === 'function') {
      void this.options.dayStateService.clearCache();
    }
  }

  getCurrentKey(): string | null {
    return this.currentKey;
  }

  async persist(dateKey?: string): Promise<void> {
    const key = dateKey ?? this.options.getCurrentDateString();
    const state = this.cache.get(key);
    if (!state) return;

    // When barrier is active, defer the write
    if (this.barrierDepth > 0) {
      const monthKey = key.substring(0, 7); // "2026-02-19" → "2026-02"
      this.pendingWriteMonthKeys.add(monthKey);
      this.pendingWriteDateKeys.add(key);
      this.pendingWriteSnapshots.set(key, this.cloneState(state));
      return;
    }

    await this.options.dayStateService.saveDay(
      this.options.parseDateString(key),
      state,
    );
    this.clearPendingForDateKey(key);
  }

  async renameTaskPath(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = typeof oldPath === 'string' ? oldPath.trim() : '';
    const normalizedNew = typeof newPath === 'string' ? newPath.trim() : '';
    if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
      return;
    }

    for (const [key, state] of this.cache.entries()) {
      if (!state) continue;
      if (renamePathsInDayState(state, normalizedOld, normalizedNew)) {
        this.cache.set(key, state);
      }
    }

    if (this.currentState) {
      renamePathsInDayState(this.currentState, normalizedOld, normalizedNew);
    }

    await this.options.dayStateService.renameTaskPath(normalizedOld, normalizedNew);
  }

  getHidden(dateKey?: string): HiddenRoutine[] {
    const state = this.getStateFor(dateKey);
    return state.hiddenRoutines ?? [];
  }

  setHidden(entries: HiddenRoutine[], dateKey?: string): void {
    const state = this.getStateFor(dateKey);
    state.hiddenRoutines = entries.filter(Boolean);
    this.persistAsync(dateKey);
  }

  isHidden(target: { instanceId?: string; path?: string; dateKey?: string }): boolean {
    const { instanceId, path } = target;
    const hiddenEntries = this.getHidden(target.dateKey);
    return hiddenEntries.some((hidden) => {
      if (!hidden) return false;
      if (typeof hidden === 'string') {
        return hidden === path;
      }
      if (!isHiddenEntry(hidden)) {
        return false;
      }
      if (hidden.instanceId && hidden.instanceId === instanceId) return true;
      if (hidden.instanceId === null && hidden.path && hidden.path === path) return true;
      return false;
    });
  }

  getDeleted(dateKey?: string): DeletedInstance[] {
    const state = this.getStateFor(dateKey);
    return state.deletedInstances ?? [];
  }

  setDeleted(entries: DeletedInstance[], dateKey?: string): void {
    const state = this.getStateFor(dateKey);
    const normalized = entries
      .filter(Boolean)
      .map((entry) => {
        if (!entry) return entry;
        const trimmedId = typeof entry.taskId === 'string' ? entry.taskId.trim() : '';
        if (trimmedId.length > 0 && entry.taskId !== trimmedId) {
          return { ...entry, taskId: trimmedId };
        }
        return entry;
      });

    const deduped: DeletedInstance[] = [];
    const permanentIndexByTaskId = new Map<string, number>();
    const getLatestOperation = (entry: DeletedInstance): number =>
      Math.max(getEffectiveDeletedAt(entry), entry.restoredAt ?? 0);
    for (const entry of normalized) {
      if (!entry) continue;
      if (entry.taskId && entry.deletionType === 'permanent') {
        const existingIndex = permanentIndexByTaskId.get(entry.taskId);
        if (existingIndex === undefined) {
          permanentIndexByTaskId.set(entry.taskId, deduped.length);
          deduped.push(entry);
          continue;
        }
        const existing = deduped[existingIndex];
        if (!existing) {
          deduped[existingIndex] = entry;
          continue;
        }
        const existingLatest = getLatestOperation(existing);
        const entryLatest = getLatestOperation(entry);
        if (entryLatest > existingLatest) {
          deduped[existingIndex] = entry;
        }
        continue;
      }
      deduped.push(entry);
    }

    state.deletedInstances = deduped;
    this.persistAsync(dateKey);
  }

  isDeleted(target: { taskId?: string; instanceId?: string; path?: string; dateKey?: string }): boolean {
    const { taskId, instanceId, path } = target;
    const deleted = this.getDeleted(target.dateKey);
    return deleted.some((entry) => {
      // First check if the entry matches
      const matches =
        (entry.instanceId && entry.instanceId === instanceId) ||
        (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) ||
        (entry.deletionType === 'permanent' && entry.path === path);

      if (!matches) return false;

      // Check if the entry is actually deleted (not restored)
      // Uses isDeletedEntry from conflictResolver which checks deletedAt vs restoredAt
      if (isDeletedEntry(entry)) {
        return true;
      }

      return isLegacyDeletionEntry(entry);
    });
  }

  getStateFor(dateKey?: string): DayState {
    const key = dateKey ?? this.options.getCurrentDateString();
    const state = this.cache.get(key);
    if (state) {
      return state;
    }
    const emptyState = this.createEmptyState();
    this.cache.set(key, emptyState);
    if (!dateKey) {
      this.setCurrent(key, emptyState);
    }
    return emptyState;
  }

  private setCurrent(key: string, state: DayState): DayState {
    this.currentKey = key;
    this.currentState = state;
    return state;
  }

  private persistAsync(dateKey?: string): void {
    void this.persist(dateKey);
  }

  private clearPendingForDateKey(dateKey: string): void {
    this.pendingWriteDateKeys.delete(dateKey);
    this.pendingWriteSnapshots.delete(dateKey);

    const monthKey = dateKey.substring(0, 7);
    const monthPrefix = `${monthKey}-`;
    const hasRemainingInMonth = Array.from(this.pendingWriteDateKeys)
      .some((pendingDateKey) => pendingDateKey.startsWith(monthPrefix));
    if (!hasRemainingInMonth) {
      this.pendingWriteMonthKeys.delete(monthKey);
    }
  }

  private normalizeState(state: DayState | null | undefined): DayState {
    if (!state) {
      return this.createEmptyState();
    }
    return {
      hiddenRoutines: state.hiddenRoutines ?? [],
      deletedInstances: state.deletedInstances ?? [],
      duplicatedInstances: state.duplicatedInstances ?? [],
      slotOverrides: state.slotOverrides ?? {},
      slotOverridesMeta: state.slotOverridesMeta,
      orders: state.orders ?? {},
      ordersMeta: state.ordersMeta,
    };
  }

  private createEmptyState(): DayState {
    return {
      hiddenRoutines: [],
      deletedInstances: [],
      duplicatedInstances: [],
      slotOverrides: {},
      orders: {},
    };
  }

  private cloneState(state: DayState): DayState {
    return JSON.parse(JSON.stringify(state)) as DayState;
  }

  private async syncCacheFromService(dateKeys: string[]): Promise<void> {
    for (const dateKey of dateKeys) {
      try {
        const loaded = await this.options.dayStateService.loadDay(
          this.options.parseDateString(dateKey),
        );
        const syncedState = this.cloneState(this.normalizeState(loaded));
        this.cache.set(dateKey, syncedState);
        if (this.currentKey === dateKey) {
          this.currentState = syncedState;
        }
      } catch (error) {
        // Avoid retaining stale local cache when post-merge sync fails.
        this.cache.delete(dateKey);
        if (this.currentKey === dateKey) {
          this.currentKey = null;
          this.currentState = null;
        }
        console.warn('[DayStateStoreService] Failed to sync cache after mergeAndSaveMonth:', dateKey, error);
      }
    }
  }

  // ─── Write Barrier ───

  /** Begin a write barrier. While active, persist/persistAsync are deferred. Supports nesting. */
  beginWriteBarrier(): void {
    this.barrierDepth++;
  }

  /**
   * End a write barrier. When depth reaches 0, flush all pending writes using mergeAndSaveMonth
   * to avoid overwriting external sync changes.
   */
  async endWriteBarrier(): Promise<void> {
    if (this.barrierDepth <= 0) {
      this.barrierDepth = 0;
      return;
    }
    this.barrierDepth--;
    if (this.barrierDepth > 0) {
      return; // Still nested — don't flush yet
    }
    await this.flushPendingWrites();
  }

  /** Returns true if a write barrier is currently active. */
  isBarrierActive(): boolean {
    return this.barrierDepth > 0;
  }

  /**
   * Flush all pending writes accumulated during barrier.
   * Groups dateKeys by monthKey and calls mergeAndSaveMonth for each group.
   * Falls back to individual saveDay calls if mergeAndSaveMonth is not available.
   */
  private async flushPendingWrites(): Promise<void> {
    const pendingDateKeys = Array.from(this.pendingWriteDateKeys);
    if (pendingDateKeys.length === 0) {
      this.pendingWriteMonthKeys.clear();
      this.pendingWriteSnapshots.clear();
      return;
    }

    const dateKeysByMonth = new Map<string, string[]>();
    for (const dateKey of pendingDateKeys) {
      const monthKey = dateKey.substring(0, 7);
      const existing = dateKeysByMonth.get(monthKey);
      if (existing) {
        existing.push(dateKey);
      } else {
        dateKeysByMonth.set(monthKey, [dateKey]);
      }
    }
    const monthKeys = Array.from(new Set([
      ...this.pendingWriteMonthKeys,
      ...dateKeysByMonth.keys(),
    ]));

    const succeededDateKeys = new Set<string>();
    const failedDateKeys = new Set<string>();

    const svc = this.options.dayStateService;
    if (typeof svc.mergeAndSaveMonth === 'function') {
      const doMergeAndSave = (mk: string, ds: Map<string, DayState>) => svc.mergeAndSaveMonth!(mk, ds);
      for (const monthKey of monthKeys) {
        const monthDateKeys = dateKeysByMonth.get(monthKey) ?? [];
        if (monthDateKeys.length === 0) continue;

        const localDayStates = new Map<string, DayState>();
        for (const dateKey of monthDateKeys) {
          const state = this.pendingWriteSnapshots.get(dateKey) ?? this.cache.get(dateKey);
          if (state) {
            localDayStates.set(dateKey, this.cloneState(state));
          } else {
            failedDateKeys.add(dateKey);
          }
        }
        if (localDayStates.size > 0) {
          try {
            await doMergeAndSave(monthKey, localDayStates);
            await this.syncCacheFromService(Array.from(localDayStates.keys()));
            for (const dateKey of localDayStates.keys()) {
              succeededDateKeys.add(dateKey);
            }
          } catch (error) {
            console.warn('[DayStateStoreService] mergeAndSaveMonth failed, falling back to saveDay:', error);
            // Fallback: write each day individually
            for (const [dk, st] of localDayStates) {
              try {
                await this.options.dayStateService.saveDay(this.options.parseDateString(dk), st);
                succeededDateKeys.add(dk);
              } catch (e) {
                failedDateKeys.add(dk);
                console.error('[DayStateStoreService] saveDay fallback failed:', dk, e);
              }
            }
          }
        }
      }
    } else {
      // Fallback: no mergeAndSaveMonth available, write individually
      for (const dateKey of pendingDateKeys) {
        const state = this.pendingWriteSnapshots.get(dateKey) ?? this.cache.get(dateKey);
        if (state) {
          try {
            await this.options.dayStateService.saveDay(
              this.options.parseDateString(dateKey),
              this.cloneState(state),
            );
            succeededDateKeys.add(dateKey);
          } catch (error) {
            failedDateKeys.add(dateKey);
            console.error('[DayStateStoreService] saveDay fallback failed:', dateKey, error);
          }
        } else {
          failedDateKeys.add(dateKey);
        }
      }
    }

    for (const dateKey of succeededDateKeys) {
      if (!failedDateKeys.has(dateKey)) {
        this.pendingWriteDateKeys.delete(dateKey);
        this.pendingWriteSnapshots.delete(dateKey);
      }
    }
    this.pendingWriteMonthKeys.clear();
    for (const dateKey of this.pendingWriteDateKeys) {
      this.pendingWriteMonthKeys.add(dateKey.substring(0, 7));
    }
    for (const dateKey of Array.from(this.pendingWriteSnapshots.keys())) {
      if (!this.pendingWriteDateKeys.has(dateKey)) {
        this.pendingWriteSnapshots.delete(dateKey);
      }
    }

    if (failedDateKeys.size > 0) {
      throw new Error(
        `[DayStateStoreService] Failed to flush pending day states: ${Array.from(failedDateKeys).join(', ')}`,
      );
    }
  }
}

export default DayStateStoreService;
