import { TFile } from 'obsidian';
import type { TaskChutePluginLike } from '../types';
import { DayState, MonthlyDayStateFile, HiddenRoutine } from '../types';
import { renamePathsInMonthlyState } from './dayState/pathRename';
import { SectionConfigService } from './SectionConfigService';
import {
  mergeDeletedInstances,
  mergeDuplicatedInstances,
  mergeHiddenRoutines,
  mergeOrders,
  mergeSlotOverrides,
  isDeleted as isDeletedEntry,
  isLegacyDeletionEntry,
} from './dayState/conflictResolver';

const DAY_STATE_VERSION = '1.0';
const LOCAL_WRITE_TTL_MS = 5000;
const MAX_HASHES_PER_PATH = 5;

/** djb2 hash for fast content hashing */
function computeContentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

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

function isOrderKeyCompatibleWithSections(orderKey: string, sectionConfig: SectionConfigService): boolean {
  const sepIdx = orderKey.indexOf('::');
  if (sepIdx < 0) return true;
  const slotPart = orderKey.slice(sepIdx + 2);
  if (!slotPart || slotPart === 'none') return true;
  return sectionConfig.isValidSlotKey(slotPart);
}

function parseIsoTimestamp(value?: string): number | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export class DayStatePersistenceService {
  private plugin: TaskChutePluginLike;
  private cache: Map<string, MonthlyDayStateFile> = new Map();
  /** Content hashes of recent local writes, keyed by file path */
  private recentLocalWriteHashes: Map<string, { hashes: Map<string, number>; timestamp: number }> = new Map();

  constructor(plugin: TaskChutePluginLike) {
    this.plugin = plugin;
  }

  private sanitizeOrderEntries(
    orders: Record<string, number>,
    meta: Record<string, { order: number; updatedAt: number }>,
    sectionConfig: SectionConfigService,
  ): {
    orders: Record<string, number>
    meta: Record<string, { order: number; updatedAt: number }>
  } {
    const sanitizedOrders: Record<string, number> = {};
    const sanitizedMeta: Record<string, { order: number; updatedAt: number }> = {};

    for (const [key, value] of Object.entries(orders)) {
      if (!isOrderKeyCompatibleWithSections(key, sectionConfig)) {
        continue;
      }
      sanitizedOrders[key] = value;
    }

    for (const [key, value] of Object.entries(meta)) {
      if (!isOrderKeyCompatibleWithSections(key, sectionConfig)) {
        continue;
      }
      sanitizedMeta[key] = value;
    }

    return { orders: sanitizedOrders, meta: sanitizedMeta };
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
    const slotOverridesMeta = record.slotOverridesMeta
    if (slotOverridesMeta && typeof slotOverridesMeta === 'object') {
      const entries = Object.entries(slotOverridesMeta as Record<string, unknown>).filter(
        ([key, val]) => {
          if (typeof key !== 'string') return false
          if (!val || typeof val !== 'object') return false
          const meta = val as { slotKey?: unknown; updatedAt?: unknown }
          return typeof meta.slotKey === 'string' && typeof meta.updatedAt === 'number'
        },
      )
      if (entries.length > 0) {
        day.slotOverridesMeta = Object.fromEntries(
          entries.map(([key, val]) => {
            const meta = val as { slotKey?: string; updatedAt?: number }
            return [key, { slotKey: meta.slotKey as string, updatedAt: meta.updatedAt as number }]
          }),
        )
      }
    }
    const orders = record.orders;
    if (orders && typeof orders === 'object') {
      const entries = Object.entries(orders as Record<string, unknown>).filter(
        ([key, val]) => typeof key === 'string' && typeof val === 'number',
      );
      day.orders = Object.fromEntries(entries) as Record<string, number>
    }
    const ordersMeta = record.ordersMeta
    if (ordersMeta && typeof ordersMeta === 'object') {
      const entries = Object.entries(ordersMeta as Record<string, unknown>).filter(
        ([key, val]) => {
          if (typeof key !== 'string') return false
          if (!val || typeof val !== 'object') return false
          const meta = val as { order?: unknown; updatedAt?: unknown }
          return typeof meta.order === 'number' && typeof meta.updatedAt === 'number'
        },
      )
      if (entries.length > 0) {
        day.ordersMeta = Object.fromEntries(
          entries.map(([key, val]) => {
            const meta = val as { order?: number; updatedAt?: number }
            return [key, { order: meta.order as number, updatedAt: meta.updatedAt as number }]
          }),
        )
      }
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

    this.recordLocalWrite(path, payload);
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
      this.recentLocalWriteHashes.delete(path);
      throw error;
    }
    this.cache.set(monthKey, month);
  }

  private toComparableDayState(state: DayState): DayState {
    const comparable: DayState = {
      hiddenRoutines: state.hiddenRoutines ?? [],
      deletedInstances: state.deletedInstances ?? [],
      duplicatedInstances: state.duplicatedInstances ?? [],
      slotOverrides: state.slotOverrides ?? {},
      orders: state.orders ?? {},
    };
    if (state.slotOverridesMeta && Object.keys(state.slotOverridesMeta).length > 0) {
      comparable.slotOverridesMeta = state.slotOverridesMeta;
    }
    if (state.ordersMeta && Object.keys(state.ordersMeta).length > 0) {
      comparable.ordersMeta = state.ordersMeta;
    }
    return comparable;
  }

  private areDayStatesEqual(a: DayState, b: DayState): boolean {
    return (
      JSON.stringify(this.toComparableDayState(a)) ===
      JSON.stringify(this.toComparableDayState(b))
    );
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

  /**
   * Merge external changes (from Obsidian Sync) with local cache.
   * Uses OR-Set + Tombstone conflict resolution.
   * - deletedInstances: newer deletedAt/restoredAt wins
   * - hiddenRoutines: newer hiddenAt/restoredAt wins
   * - slotOverrides: newer updatedAt wins
   */
  async mergeExternalChange(monthKey: string): Promise<{
    merged: MonthlyDayStateFile | null
    affectedDateKeys: string[]
  }> {
    const localCached = this.cache.get(monthKey);

    // Read remote state from file
    const path = this.getStatePath(monthKey);
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);

    if (!existing || !(existing instanceof TFile)) {
      // File doesn't exist - nothing to merge
      return {
        merged: localCached ?? null,
        affectedDateKeys: [],
      };
    }

    let remoteState: MonthlyDayStateFile;
    try {
      const raw = await this.plugin.app.vault.read(existing);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      remoteState = this.normalizeMonthlyState(parsed);
    } catch (error) {
      console.error('[DayStatePersistenceService] Failed to parse remote state for merge:', error);
      return {
        merged: localCached ?? null,
        affectedDateKeys: [],
      };
    }

    // If no local cache, just use remote
    if (!localCached) {
      this.cache.set(monthKey, remoteState);
      return {
        merged: remoteState,
        affectedDateKeys: Object.keys(remoteState.days),
      };
    }

    // Merge each day's state
    const mergedMonthly = cloneMonthlyState(localCached);
    let hasChanges = false;
    const affectedDateKeys: string[] = [];
    const remoteMonthUpdatedAt = parseIsoTimestamp(remoteState.metadata?.lastUpdated);

    // Get all date keys from both local and remote
    const allDateKeys = new Set([
      ...Object.keys(localCached.days),
      ...Object.keys(remoteState.days),
    ]);

    for (const dateKey of allDateKeys) {
      const localDay = localCached.days[dateKey] ?? createEmptyDayState();
      const remoteDay = remoteState.days[dateKey] ?? createEmptyDayState();

      // Merge deletedInstances
      const deletedResult = mergeDeletedInstances(
        localDay.deletedInstances ?? [],
        remoteDay.deletedInstances ?? [],
      );

      const isActiveDeletion = (entry: DayState['deletedInstances'][number]): boolean =>
        Boolean(entry) && (isDeletedEntry(entry) || isLegacyDeletionEntry(entry));
      const deletedInstanceIds = new Set<string>();
      const deletedPaths = new Set<string>();
      const deletedTaskIds = new Set<string>();
      for (const entry of deletedResult.merged) {
        if (!isActiveDeletion(entry)) continue;
        if (entry.instanceId) {
          deletedInstanceIds.add(entry.instanceId);
        }
        if (entry.deletionType === 'permanent') {
          if (entry.path) {
            deletedPaths.add(entry.path);
          }
          if (entry.taskId) {
            deletedTaskIds.add(entry.taskId);
          }
        }
      }

      // Merge hiddenRoutines
      const hiddenResult = mergeHiddenRoutines(
        localDay.hiddenRoutines ?? [],
        remoteDay.hiddenRoutines ?? [],
      );

      // Merge slotOverrides (using simple timestamp comparison)
      const slotResult = mergeSlotOverrides(
        localDay.slotOverrides ?? {},
        localDay.slotOverridesMeta ?? {},
        remoteDay.slotOverrides ?? {},
        remoteDay.slotOverridesMeta ?? {},
      );

      // Merge orders based on ordersMeta updatedAt
      const ordersResult = mergeOrders(
        localDay.orders ?? {},
        localDay.ordersMeta ?? {},
        remoteDay.orders ?? {},
        remoteDay.ordersMeta ?? {},
        { remoteMonthUpdatedAt },
      );

      // Merge duplicatedInstances (by instanceId, keep both unless deleted)
      const duplicatedResult = mergeDuplicatedInstances(
        localDay.duplicatedInstances ?? [],
        remoteDay.duplicatedInstances ?? [],
        { deletedInstanceIds, deletedPaths, deletedTaskIds },
      );

      const mergedDay: DayState = {
        hiddenRoutines: hiddenResult.merged,
        deletedInstances: deletedResult.merged,
        duplicatedInstances: duplicatedResult.merged,
        slotOverrides: slotResult.merged,
        slotOverridesMeta: Object.keys(slotResult.meta).length > 0 ? slotResult.meta : undefined,
        orders: ordersResult.merged,
        ordersMeta: Object.keys(ordersResult.meta).length > 0 ? ordersResult.meta : undefined,
      };

      const mergedDiffersFromLocal = !this.areDayStatesEqual(mergedDay, localDay);

      // Check if there were actual changes
      if (
        deletedResult.hasConflicts ||
        hiddenResult.hasConflicts ||
        slotResult.hasConflicts ||
        ordersResult.hasConflicts ||
        mergedDiffersFromLocal
      ) {
        hasChanges = true;
        affectedDateKeys.push(dateKey);
      }

      mergedMonthly.days[dateKey] = mergedDay;
    }

    // Update cache
    mergedMonthly.metadata.lastUpdated = new Date().toISOString();
    this.cache.set(monthKey, mergedMonthly);

    // Persist merged state if there were changes
    if (hasChanges) {
      try {
        await this.writeMonth(monthKey, mergedMonthly);
      } catch (error) {
        console.warn('[DayStatePersistenceService] Failed to persist merged state:', error);
      }
    }

    return {
      merged: mergedMonthly,
      affectedDateKeys,
    };
  }

  /**
   * Merge local DayState changes with on-disk data and save atomically per month.
   * Used by the write barrier flush to avoid overwriting external sync changes.
   *
   * 1. Clears cache for the month to force a fresh disk read
   * 2. For each dateKey, merges local state with disk state using conflict resolution
   * 3. Writes the merged result back in a single I/O operation
   */
  async mergeAndSaveMonth(
    monthKey: string,
    localDayStates: Map<string, DayState>,
  ): Promise<void> {
    if (localDayStates.size === 0) return;

    // Clear cache to force a fresh read from disk
    this.cache.delete(monthKey);
    const diskMonth = await this.loadMonth(monthKey);

    const mergedMonthly = cloneMonthlyState(diskMonth);
    const sectionConfig = new SectionConfigService(this.plugin.settings.customSections);
    const remoteMonthUpdatedAt = parseIsoTimestamp(diskMonth.metadata?.lastUpdated);

    for (const [dateKey, localDay] of localDayStates) {
      const diskDay = diskMonth.days[dateKey] ?? createEmptyDayState();

      // Merge deletedInstances
      const deletedResult = mergeDeletedInstances(
        localDay.deletedInstances ?? [],
        diskDay.deletedInstances ?? [],
      );

      // Build deleted info for duplicatedInstances suppression
      const isActiveDeletion = (entry: DayState['deletedInstances'][number]): boolean =>
        Boolean(entry) && (isDeletedEntry(entry) || isLegacyDeletionEntry(entry));
      const deletedInstanceIds = new Set<string>();
      const deletedPaths = new Set<string>();
      const deletedTaskIds = new Set<string>();
      for (const entry of deletedResult.merged) {
        if (!isActiveDeletion(entry)) continue;
        if (entry.instanceId) {
          deletedInstanceIds.add(entry.instanceId);
        }
        if (entry.deletionType === 'permanent') {
          if (entry.path) {
            deletedPaths.add(entry.path);
          }
          if (entry.taskId) {
            deletedTaskIds.add(entry.taskId);
          }
        }
      }

      // Merge hiddenRoutines
      const hiddenResult = mergeHiddenRoutines(
        localDay.hiddenRoutines ?? [],
        diskDay.hiddenRoutines ?? [],
      );

      // Merge slotOverrides
      const slotResult = mergeSlotOverrides(
        localDay.slotOverrides ?? {},
        localDay.slotOverridesMeta ?? {},
        diskDay.slotOverrides ?? {},
        diskDay.slotOverridesMeta ?? {},
      );

      const sanitizedLocalOrders = this.sanitizeOrderEntries(
        localDay.orders ?? {},
        localDay.ordersMeta ?? {},
        sectionConfig,
      );
      const sanitizedDiskOrders = this.sanitizeOrderEntries(
        diskDay.orders ?? {},
        diskDay.ordersMeta ?? {},
        sectionConfig,
      );

      // Merge orders
      const ordersResult = mergeOrders(
        sanitizedLocalOrders.orders,
        sanitizedLocalOrders.meta,
        sanitizedDiskOrders.orders,
        sanitizedDiskOrders.meta,
        { preferRemoteWithoutMeta: true, remoteMonthUpdatedAt },
      );

      // In no-meta local-only keys, preserve local values (remote-only remains remote-preferred).
      for (const [key, localOrder] of Object.entries(sanitizedLocalOrders.orders)) {
        const hasAnyMeta = Boolean(sanitizedLocalOrders.meta[key] || sanitizedDiskOrders.meta[key]);
        if (hasAnyMeta) continue;
        if (sanitizedDiskOrders.orders[key] === undefined && typeof localOrder === 'number') {
          ordersResult.merged[key] = localOrder;
        }
      }

      // Merge duplicatedInstances
      const duplicatedResult = mergeDuplicatedInstances(
        localDay.duplicatedInstances ?? [],
        diskDay.duplicatedInstances ?? [],
        { deletedInstanceIds, deletedPaths, deletedTaskIds },
      );

      mergedMonthly.days[dateKey] = {
        hiddenRoutines: hiddenResult.merged,
        deletedInstances: deletedResult.merged,
        duplicatedInstances: duplicatedResult.merged,
        slotOverrides: slotResult.merged,
        slotOverridesMeta: Object.keys(slotResult.meta).length > 0 ? slotResult.meta : undefined,
        orders: ordersResult.merged,
        ordersMeta: Object.keys(ordersResult.meta).length > 0 ? ordersResult.meta : undefined,
      };
    }

    mergedMonthly.metadata.lastUpdated = new Date().toISOString();
    await this.writeMonth(monthKey, mergedMonthly);
  }

  /**
   * Extract month key from state file path
   */
  getMonthKeyFromPath(path: string): string | null {
    return this.extractMonthKeyFromPath(path);
  }

  /**
   * Check if a file change was caused by our own write (content hash comparison).
   * @param path - File path to check
   * @param content - Optional file content for hash comparison. If omitted, returns false (safe side: treat as external).
   * @param maxRecordedAt - Optional event timestamp guard. Hashes recorded after this time are not consumed.
   * @returns true if this was our own write and should be ignored
   */
  consumeLocalStateWrite(path: string, content?: string, maxRecordedAt?: number): boolean {
    const now = Date.now();
    const recorded = this.recentLocalWriteHashes.get(path);
    if (!recorded) {
      this.pruneLocalWrites(now);
      return false;
    }
    if (now - recorded.timestamp > LOCAL_WRITE_TTL_MS) {
      this.recentLocalWriteHashes.delete(path);
      return false;
    }

    // If no content provided, cannot verify — treat as external change (safe side)
    if (content === undefined) {
      return false;
    }

    const hash = computeContentHash(content);
    const hashRecordedAt = recorded.hashes.get(hash);
    if (hashRecordedAt === undefined) {
      return false;
    }
    if (typeof maxRecordedAt === 'number' && hashRecordedAt > maxRecordedAt) {
      return false;
    }
    recorded.hashes.delete(hash);
    // Clean up if no more hashes remain
    if (recorded.hashes.size === 0) {
      this.recentLocalWriteHashes.delete(path);
    }
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

  private recordLocalWrite(path: string, content: string): void {
    const now = Date.now();
    const hash = computeContentHash(content);
    const existing = this.recentLocalWriteHashes.get(path);
    if (existing) {
      existing.hashes.set(hash, now);
      existing.timestamp = now;
      // Limit stored hashes per path
      if (existing.hashes.size > MAX_HASHES_PER_PATH) {
        let oldestHash: string | null = null;
        let oldestTimestamp = Number.POSITIVE_INFINITY;
        for (const [candidateHash, candidateTimestamp] of existing.hashes.entries()) {
          if (candidateTimestamp < oldestTimestamp) {
            oldestTimestamp = candidateTimestamp;
            oldestHash = candidateHash;
          }
        }
        if (oldestHash) {
          existing.hashes.delete(oldestHash);
        }
      }
    } else {
      this.recentLocalWriteHashes.set(path, {
        hashes: new Map([[hash, now]]),
        timestamp: now,
      });
    }
    this.pruneLocalWrites(now);
  }

  private pruneLocalWrites(now: number): void {
    for (const [path, entry] of this.recentLocalWriteHashes.entries()) {
      if (now - entry.timestamp > LOCAL_WRITE_TTL_MS) {
        this.recentLocalWriteHashes.delete(path);
      }
    }
  }
}

export default DayStatePersistenceService;
