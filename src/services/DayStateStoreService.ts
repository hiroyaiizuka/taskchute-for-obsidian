import { DayState, DeletedInstance, HiddenRoutine, DayStateServiceAPI } from '../types';
import { renamePathsInDayState } from './dayState/pathRename';

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
    await this.options.dayStateService.saveDay(
      this.options.parseDateString(key),
      state,
    );
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
    const seenPermanentTaskIds = new Set<string>();
    for (const entry of normalized) {
      if (!entry) continue;
      if (
        entry.taskId &&
        entry.deletionType === 'permanent' &&
        seenPermanentTaskIds.has(entry.taskId)
      ) {
        continue;
      }
      if (entry.taskId && entry.deletionType === 'permanent') {
        seenPermanentTaskIds.add(entry.taskId);
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
      if (entry.instanceId && entry.instanceId === instanceId) return true;
      if (taskId && entry.taskId && entry.deletionType === 'permanent' && entry.taskId === taskId) {
        return true;
      }
      if (entry.deletionType === 'permanent' && entry.path === path) return true;
      return false;
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

  private normalizeState(state: DayState | null | undefined): DayState {
    if (!state) {
      return this.createEmptyState();
    }
    return {
      hiddenRoutines: state.hiddenRoutines ?? [],
      deletedInstances: state.deletedInstances ?? [],
      duplicatedInstances: state.duplicatedInstances ?? [],
      slotOverrides: state.slotOverrides ?? {},
      orders: state.orders ?? {},
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
}

export default DayStateStoreService;
