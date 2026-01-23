import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../types';
import { DayState, MonthlyDayStateFile, HiddenRoutine } from '../types';
import { renamePathsInMonthlyState } from './dayState/pathRename';

const DAY_STATE_VERSION = '1.0';
const LOCAL_WRITE_TTL_MS = 1000;

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

export class DayStatePersistenceService {
  private plugin: TaskChutePluginLike;
  private cache: Map<string, MonthlyDayStateFile> = new Map();
  private recentLocalWrites: Map<string, number> = new Map();

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

  private collectStateFiles(): TFile[] {
    const base = this.plugin.pathManager.getLogDataPath();
    const vault = this.plugin.app.vault as { getFiles?: () => TFile[] };
    const suffix = '-state.json';
    const files: TFile[] = [];

    if (typeof vault.getFiles === 'function') {
      const candidates = vault.getFiles();
      candidates.forEach((candidate) => {
        if (candidate instanceof TFile && candidate.path.startsWith(`${base}/`) && candidate.path.endsWith(suffix)) {
          files.push(candidate);
        }
      });
      if (files.length > 0) {
        return files;
      }
    }

    const seen = new Set<string>();
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthKey = this.getMonthKey(date);
      const path = this.getStatePath(monthKey);
      if (seen.has(path)) continue;
      seen.add(path);
      const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
      if (abstract && abstract instanceof TFile) {
        files.push(abstract);
      }
    }
    return files;
  }

  private extractMonthKeyFromPath(path: string): string | null {
    const base = `${this.plugin.pathManager.getLogDataPath()}/`;
    const suffix = '-state.json';
    if (!path.startsWith(base) || !path.endsWith(suffix)) {
      return null;
    }
    return path.slice(base.length, path.length - suffix.length);
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

  private normalizeMonthlyState(state: unknown): MonthlyDayStateFile {
    const normalized: MonthlyDayStateFile = {
      days: {},
      metadata: {
        version: DAY_STATE_VERSION,
        lastUpdated: new Date().toISOString(),
      },
    };

    if (state && typeof state === 'object') {
      const record = state as {
        days?: Record<string, unknown>
        metadata?: Record<string, unknown>
      }
      if (record.days && typeof record.days === 'object') {
        for (const [key, value] of Object.entries(record.days)) {
          normalized.days[key] = this.normalizeDayState(value);
        }
      }
      if (record.metadata && typeof record.metadata === 'object') {
        const meta = record.metadata as {
          version?: unknown
          lastUpdated?: unknown
        }
        normalized.metadata.version =
          typeof meta.version === 'string' && meta.version.trim().length > 0
            ? meta.version
            : DAY_STATE_VERSION;
        normalized.metadata.lastUpdated =
          typeof meta.lastUpdated === 'string' && meta.lastUpdated.trim().length > 0
            ? meta.lastUpdated
            : new Date().toISOString();
      }
    }

    return normalized;
  }

  private normalizeDayState(value: unknown): DayState {
    const day = createEmptyDayState();

    if (!value || typeof value !== 'object') {
      return day;
    }

    const record = value as Record<string, unknown>;

    const hiddenRoutines = record.hiddenRoutines;
    if (Array.isArray(hiddenRoutines)) {
      day.hiddenRoutines = hiddenRoutines.filter(Boolean) as HiddenRoutine[];
    }
    const deletedInstances = record.deletedInstances;
    if (Array.isArray(deletedInstances)) {
      day.deletedInstances = deletedInstances.filter(Boolean) as DayState['deletedInstances'];
    }
    const duplicatedInstances = record.duplicatedInstances;
    if (Array.isArray(duplicatedInstances)) {
      day.duplicatedInstances = duplicatedInstances.filter(Boolean) as DayState['duplicatedInstances'];
    }
    const slotOverrides = record.slotOverrides;
    if (slotOverrides && typeof slotOverrides === 'object') {
      const entries = Object.entries(slotOverrides as Record<string, unknown>).filter(
        ([key, val]) => typeof key === 'string' && typeof val === 'string',
      );
      day.slotOverrides = Object.fromEntries(entries) as Record<string, string>
    }
    const orders = record.orders;
    if (orders && typeof orders === 'object') {
      const entries = Object.entries(orders as Record<string, unknown>).filter(
        ([key, val]) => typeof key === 'string' && typeof val === 'number',
      );
      day.orders = Object.fromEntries(entries) as Record<string, number>
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
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        monthly = this.normalizeMonthlyState(parsed);
      } catch (error) {
        console.error('[TaskChute] Failed to parse day state file:', error);
        monthly = this.normalizeMonthlyState({});
      }
    } else {
      monthly = this.normalizeMonthlyState({});
    }

    this.ensureMetadata(monthly);
    this.cache.set(monthKey, monthly);
    return monthly;
  }

  private async writeMonth(monthKey: string, month: MonthlyDayStateFile): Promise<void> {
    const path = this.getStatePath(monthKey);
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    const payload = JSON.stringify(month, null, 2);

    this.recordLocalWrite(path);
    try {
      if (file && file instanceof TFile) {
        await this.plugin.app.vault.modify(file, payload);
      } else {
        await this.plugin.pathManager.ensureFolderExists(
          this.plugin.pathManager.getLogDataPath(),
        );
        await this.plugin.app.vault.create(path, payload);
      }
    } catch (error) {
      this.recentLocalWrites.delete(path);
      throw error;
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
        const mergedHiddenRoutines = Array.from(existing.values()).reduce<HiddenRoutine[]>(
          (acc, entry) => {
            if (!entry) return acc;
            if (typeof entry === 'string') {
              acc.push({ path: entry, instanceId: null });
            } else {
              acc.push(entry);
            }
            return acc;
          },
          [],
        );
        state.hiddenRoutines = mergedHiddenRoutines;
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

  async renameTaskPath(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = typeof oldPath === 'string' ? oldPath.trim() : '';
    const normalizedNew = typeof newPath === 'string' ? newPath.trim() : '';
    if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) {
      return;
    }

    const files = this.collectStateFiles();
    for (const file of files) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const monthly = this.normalizeMonthlyState(parsed);
        const mutated = renamePathsInMonthlyState(monthly, normalizedOld, normalizedNew);
        if (!mutated) {
          continue;
        }
        this.ensureMetadata(monthly);
        await this.plugin.app.vault.modify(file, JSON.stringify(monthly, null, 2));
        const monthKey = this.extractMonthKeyFromPath(file.path);
        if (monthKey) {
          this.cache.set(monthKey, monthly);
        }
      } catch (error) {
        console.warn('[DayStatePersistenceService] Failed to rename task path', file.path, error);
      }
    }

    for (const [monthKey, cached] of this.cache.entries()) {
      if (!cached) continue;
      if (renamePathsInMonthlyState(cached, normalizedOld, normalizedNew)) {
        this.cache.set(monthKey, cached);
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  clearCacheForDate(dateKey: string): void {
    const date = this.getDateFromKey(dateKey);
    const monthKey = this.getMonthKey(date);
    this.cache.delete(monthKey);
  }

  consumeLocalStateWrite(path: string): boolean {
    const now = Date.now();
    const recorded = this.recentLocalWrites.get(path);
    if (!recorded) {
      this.pruneLocalWrites(now);
      return false;
    }
    if (now - recorded > LOCAL_WRITE_TTL_MS) {
      this.recentLocalWrites.delete(path);
      return false;
    }
    this.recentLocalWrites.delete(path);
    return true;
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

  private recordLocalWrite(path: string): void {
    const now = Date.now();
    this.recentLocalWrites.set(path, now);
    this.pruneLocalWrites(now);
  }

  private pruneLocalWrites(now: number): void {
    for (const [path, timestamp] of this.recentLocalWrites.entries()) {
      if (now - timestamp > LOCAL_WRITE_TTL_MS) {
        this.recentLocalWrites.delete(path);
      }
    }
  }
}

export default DayStatePersistenceService;
