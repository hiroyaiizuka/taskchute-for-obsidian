import { DayState, DeletedInstance, HiddenRoutine, DayStateServiceAPI } from '../types';

export interface DayStateManagerOptions {
  dayStateService: DayStateServiceAPI;
  getCurrentDateString: () => string;
  parseDateString: (dateKey: string) => Date;
  cache?: Map<string, DayState>;
}

export class DayStateManager {
  private cache: Map<string, DayState>;
  private currentKey: string | null = null;
  private currentState: DayState | null = null;

  constructor(private readonly options: DayStateManagerOptions) {
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
    state.deletedInstances = entries.filter(Boolean);
    this.persistAsync(dateKey);
  }

  isDeleted(target: { instanceId?: string; path?: string; dateKey?: string }): boolean {
    const { instanceId, path } = target;
    const deleted = this.getDeleted(target.dateKey);
    return deleted.some((entry) => {
      if (entry.instanceId && entry.instanceId === instanceId) return true;
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

export default DayStateManager;
