import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../types';
import { DayState, MonthlyDayStateFile } from '../types';

const DAY_STATE_VERSION = '1.0';

function cloneDayState(state: DayState): DayState {
  return JSON.parse(JSON.stringify(state)) as DayState;
}

function cloneMonthlyState(state: MonthlyDayStateFile): MonthlyDayStateFile {
  return JSON.parse(JSON.stringify(state)) as MonthlyDayStateFile;
}

function createEmptyDayState(): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
  };
}

export class DayStateService {
  private plugin: TaskChutePluginLike;
  private cache: Map<string, MonthlyDayStateFile> = new Map();

  constructor(plugin: TaskChutePluginLike) {
    this.plugin = plugin;
  }

  private getMonthKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private getDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private getStatePath(monthKey: string): string {
    const base = this.plugin.pathManager.getLogDataPath();
    return `${base}/${monthKey}-state.json`;
  }

  private ensureMetadata(state: MonthlyDayStateFile): void {
    if (!state.metadata) {
      state.metadata = { version: DAY_STATE_VERSION, lastUpdated: new Date().toISOString() };
      return;
    }
    if (!state.metadata.version) {
      state.metadata.version = DAY_STATE_VERSION;
    }
    if (!state.metadata.lastUpdated) {
      state.metadata.lastUpdated = new Date().toISOString();
    }
  }

  private normalizeMonthlyState(state: any): MonthlyDayStateFile {
    const normalized: MonthlyDayStateFile = {
      days: {},
      metadata: {
        version: DAY_STATE_VERSION,
        lastUpdated: new Date().toISOString(),
      },
    };

    if (state && typeof state === 'object') {
      if (state.days && typeof state.days === 'object') {
        for (const [key, value] of Object.entries(state.days)) {
          normalized.days[key] = this.normalizeDayState(value);
        }
      }
      if (state.metadata) {
        normalized.metadata.version = state.metadata.version || DAY_STATE_VERSION;
        normalized.metadata.lastUpdated =
          state.metadata.lastUpdated || new Date().toISOString();
      }
    }

    return normalized;
  }

  private normalizeDayState(value: any): DayState {
    const day = createEmptyDayState();

    if (!value || typeof value !== 'object') {
      return day;
    }

    if (Array.isArray(value.hiddenRoutines)) {
      day.hiddenRoutines = value.hiddenRoutines.filter(Boolean);
    }
    if (Array.isArray(value.deletedInstances)) {
      day.deletedInstances = value.deletedInstances.filter(Boolean);
    }
    if (Array.isArray(value.duplicatedInstances)) {
      day.duplicatedInstances = value.duplicatedInstances.filter(Boolean);
    }
    if (value.slotOverrides && typeof value.slotOverrides === 'object') {
      const entries = Object.entries(value.slotOverrides).filter(
        ([key, val]) => typeof key === 'string' && typeof val === 'string',
      );
      day.slotOverrides = Object.fromEntries(entries);
    }
    if (value.orders && typeof value.orders === 'object') {
      const entries = Object.entries(value.orders).filter(
        ([key, val]) => typeof key === 'string' && typeof val === 'number',
      );
      day.orders = Object.fromEntries(entries);
    }

    return day;
  }

  private async loadMonth(monthKey: string): Promise<MonthlyDayStateFile> {
    if (this.cache.has(monthKey)) {
      return this.cache.get(monthKey)!;
    }

    const path = this.getStatePath(monthKey);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);

    let monthly: MonthlyDayStateFile;

    if (existing && existing instanceof TFile) {
      try {
        const raw = await this.plugin.app.vault.read(existing);
        const parsed = raw ? JSON.parse(raw) : {};
        monthly = this.normalizeMonthlyState(parsed);
      } catch (error) {
        console.error('[TaskChute] Failed to parse day state file:', error);
        monthly = this.normalizeMonthlyState({});
      }
    } else {
      monthly = this.normalizeMonthlyState({});
      await this.plugin.pathManager.ensureFolderExists(
        this.plugin.pathManager.getLogDataPath(),
      );
      await this.plugin.app.vault.create(path, JSON.stringify(monthly, null, 2));
    }

    this.ensureMetadata(monthly);
    this.cache.set(monthKey, monthly);
    return monthly;
  }

  private async writeMonth(monthKey: string, month: MonthlyDayStateFile): Promise<void> {
    const path = this.getStatePath(monthKey);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    const payload = JSON.stringify(month, null, 2);

    if (file && file instanceof TFile) {
      await this.plugin.app.vault.modify(file, payload);
    } else {
      await this.plugin.pathManager.ensureFolderExists(
        this.plugin.pathManager.getLogDataPath(),
      );
      await this.plugin.app.vault.create(path, payload);
    }
    this.cache.set(monthKey, month);
  }

  private areDayStatesEqual(a: DayState, b: DayState): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async loadDay(date: Date): Promise<DayState> {
    const monthKey = this.getMonthKey(date);
    const dateKey = this.getDateKey(date);
    const month = await this.loadMonth(monthKey);
    if (!month.days[dateKey]) {
      month.days[dateKey] = createEmptyDayState();
      month.metadata.lastUpdated = new Date().toISOString();
      await this.writeMonth(monthKey, month);
    }
    return cloneDayState(month.days[dateKey]);
  }

  async saveDay(date: Date, state: DayState): Promise<void> {
    const monthKey = this.getMonthKey(date);
    const dateKey = this.getDateKey(date);
    const month = await this.loadMonth(monthKey);
    const existing = month.days[dateKey] ?? createEmptyDayState();
    if (this.areDayStatesEqual(existing, state)) {
      return;
    }
    month.days[dateKey] = cloneDayState(state);
    month.metadata.lastUpdated = new Date().toISOString();
    await this.writeMonth(monthKey, month);
  }

  async updateDay(
    date: Date,
    mutator: (state: DayState) => DayState | void,
  ): Promise<DayState> {
    const monthKey = this.getMonthKey(date);
    const dateKey = this.getDateKey(date);
    const month = await this.loadMonth(monthKey);
    const current = month.days[dateKey] ?? createEmptyDayState();
    const working = cloneDayState(current);
    const result = (mutator(working) as DayState) || working;
    if (!this.areDayStatesEqual(current, result)) {
      month.days[dateKey] = cloneDayState(result);
      month.metadata.lastUpdated = new Date().toISOString();
      await this.writeMonth(monthKey, month);
    }
    return cloneDayState(month.days[dateKey]);
  }

  async mergeDayState(date: Date, partial: Partial<DayState>): Promise<void> {
    await this.updateDay(date, (state) => {
      if (partial.hiddenRoutines) {
        const existing = new Map(
          state.hiddenRoutines.map((item) => {
            if (typeof item === 'string') {
              return [item, item];
            }
            const key = `${item.path || ''}::${item.instanceId ?? ''}`;
            return [key, item];
          }),
        );
        for (const item of partial.hiddenRoutines) {
          if (typeof item === 'string') {
            existing.set(item, item);
          } else if (item) {
            const key = `${item.path || ''}::${item.instanceId ?? ''}`;
            existing.set(key, item);
          }
        }
        state.hiddenRoutines = Array.from(existing.values()) as any;
      }

      if (partial.deletedInstances) {
        const existing = new Map(
          state.deletedInstances.map((item) => {
            const key = `${item.deletionType || ''}::${item.path || ''}::${
              item.instanceId || ''
            }`;
            return [key, item];
          }),
        );
        for (const item of partial.deletedInstances) {
          if (!item) continue;
          const key = `${item.deletionType || ''}::${item.path || ''}::${
            item.instanceId || ''
          }`;
          existing.set(key, item);
        }
        state.deletedInstances = Array.from(existing.values());
      }

      if (partial.duplicatedInstances) {
        const existing = new Map(
          state.duplicatedInstances.map((item) => [item.instanceId, item]),
        );
        for (const item of partial.duplicatedInstances) {
          if (!item || !item.instanceId) continue;
          existing.set(item.instanceId, item);
        }
        state.duplicatedInstances = Array.from(existing.values());
      }

      if (partial.orders) {
        state.orders = {
          ...state.orders,
          ...partial.orders,
        };
      }

      if (partial.slotOverrides) {
        state.slotOverrides = {
          ...state.slotOverrides,
          ...partial.slotOverrides,
        };
      }

      return state;
    });
  }

  async clearCache(): Promise<void> {
    this.cache.clear();
  }

  cloneDayState(state: DayState): DayState {
    return cloneDayState(state);
  }

  cloneMonthlyState(state: MonthlyDayStateFile): MonthlyDayStateFile {
    return cloneMonthlyState(state);
  }

  getDateFromKey(dateKey: string): Date {
    const [y, m, d] = dateKey.split('-').map((value) => parseInt(value, 10));
    return new Date(y, m - 1, d);
  }
}

export default DayStateService;
