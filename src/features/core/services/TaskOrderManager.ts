import DayStateStoreService from '../../../services/DayStateStoreService';
import { DayState, TaskInstance } from '../../../types';

export interface TaskOrderManagerOptions {
  dayStateManager: DayStateStoreService;
  getCurrentDateString: () => string;
  ensureDayStateForCurrentDate: () => Promise<DayState>;
  getCurrentDayState: () => DayState;
  persistDayState: (dateKey: string) => Promise<void>;
  getTimeSlotKeys: () => string[];
  getOrderKey: (inst: TaskInstance) => string | null;
  useOrderBasedSort: () => boolean;
  normalizeState: (state: TaskInstance['state']) => 'done' | 'running' | 'idle';
  getStatePriority: (state: TaskInstance['state']) => number;
  handleOrderSaveError?: (error: unknown) => void;
}

interface EnsureOptions {
  forceDone?: boolean;
  persist?: boolean;
}

export class TaskOrderManager {
  constructor(private readonly options: TaskOrderManagerOptions) {}

  private getCreatedMillis(inst: TaskInstance): number | null {
    const fromInstance = inst.createdMillis;
    if (typeof fromInstance === 'number' && Number.isFinite(fromInstance)) {
      return fromInstance;
    }
    const fromTask = inst.task?.createdMillis;
    if (typeof fromTask === 'number' && Number.isFinite(fromTask)) {
      return fromTask;
    }
    return null;
  }

  private getTaskTitle(task: TaskInstance['task'] | undefined): string {
    if (!task) return '';
    if (typeof task.displayTitle === 'string' && task.displayTitle.trim().length > 0) {
      return task.displayTitle;
    }
    return typeof task.name === 'string' ? task.name : '';
  }

  private getScheduledMinutes(task: TaskInstance['task'] | undefined): number | null {
    const value = task?.scheduledTime;
    if (typeof value !== 'string') {
      return null;
    }
    const [hours, minutes] = value.split(':');
    const hourNum = Number.parseInt(hours ?? '', 10);
    const minuteNum = Number.parseInt(minutes ?? '', 10);
    if (Number.isNaN(hourNum) || Number.isNaN(minuteNum)) {
      return null;
    }
    return hourNum * 60 + minuteNum;
  }

  sortTaskInstancesByTimeOrder(instances: TaskInstance[]): void {
    if (!this.options.useOrderBasedSort()) {
      return;
    }
    const savedOrders = this.loadSavedOrders();
    this.applySavedOrders(instances, savedOrders);
    this.ensureOrdersAcrossSlots(instances, { forceDone: true });
  }

  loadSavedOrders(): Record<string, number> {
    const dateStr = this.options.getCurrentDateString();
    const state = this.options.dayStateManager.getStateFor(dateStr);
    if (!state || !state.orders) {
      return {};
    }

    const raw = state.orders;
    const normalized: Record<string, number> = {};
    let mutated = false;

    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        normalized[key] = value;
        continue;
      }

      if (value && typeof value === 'object') {
        const valueRecord = value as { order?: unknown; slot?: unknown };
        const order = Number(valueRecord.order);
        if (!Number.isFinite(order)) continue;
        const slot = typeof valueRecord.slot === 'string' ? valueRecord.slot : 'none';
        const normalizedKey = key.includes('::') ? key : `${key}::${slot}`;
        normalized[normalizedKey] = order;
        mutated = true;
      }
    }

    if (mutated || Object.values(raw).some((candidate) => typeof candidate !== 'number')) {
      state.orders = normalized;
      void this.options.persistDayState(dateStr);
    }

    return normalized;
  }

  applySavedOrders(instances: TaskInstance[], savedOrders: Record<string, number>): void {
    instances.forEach((inst) => {
      const key = this.options.getOrderKey(inst);
      if (!key) return;
      const saved = savedOrders[key];
      if (typeof saved === 'number' && Number.isFinite(saved)) {
        inst.order = saved;
      }
    });
  }

  ensureOrdersAcrossSlots(
    instances: TaskInstance[],
    options: EnsureOptions = {},
  ): void {
    const slots = new Set<string>(['none', ...this.options.getTimeSlotKeys()]);
    slots.forEach((slot) => {
      this.ensureOrdersForSlot(instances, slot, options);
    });

    if (options.persist) {
      void this.saveTaskOrders(instances).catch((error) => {
        console.error('[TaskOrderManager] Failed to save task orders', error);
        this.options.handleOrderSaveError?.(error);
      });
    }
  }

  async saveTaskOrders(instances: TaskInstance[]): Promise<void> {
    await this.options.ensureDayStateForCurrentDate();
    const dateStr = this.options.getCurrentDateString();
    const dayState = this.options.getCurrentDayState();

    const orders: Record<string, number> = {};
    instances.forEach((inst) => {
      if (inst.order === undefined || inst.order === null) return;
      const key = this.options.getOrderKey(inst);
      if (!key) return;
      orders[key] = inst.order;
    });

    if (Array.isArray(dayState.duplicatedInstances) && dayState.duplicatedInstances.length > 0) {
      dayState.duplicatedInstances = dayState.duplicatedInstances.map((dup) => {
        if (!dup || !dup.instanceId) return dup;
        const match = instances.find((candidate) => candidate.instanceId === dup.instanceId);
        if (!match) return dup;
        return {
          ...dup,
          slotKey: match.slotKey,
          originalSlotKey: match.originalSlotKey ?? dup.originalSlotKey,
        };
      });
    }

    dayState.orders = orders;
    await this.options.persistDayState(dateStr);
  }

  sortByOrder(instances: TaskInstance[]): TaskInstance[] {
    return [...instances].sort((a, b) => {
      const sa = this.options.getStatePriority(a.state);
      const sb = this.options.getStatePriority(b.state);
      if (sa !== sb) return sa - sb;

      const hasOrderA = a.order !== undefined && a.order !== null;
      const hasOrderB = b.order !== undefined && b.order !== null;
      if (hasOrderA && hasOrderB) {
        if (a.order! !== b.order!) {
          return a.order! - b.order!;
        }
      } else if (hasOrderA && !hasOrderB) {
        return -1;
      } else if (!hasOrderA && hasOrderB) {
        return 1;
      }

      if (this.options.normalizeState(a.state) === 'done' && this.options.normalizeState(b.state) === 'done') {
        const ta = a.startTime ? a.startTime.getTime() : Infinity;
        const tb = b.startTime ? b.startTime.getTime() : Infinity;
        if (ta !== tb) return ta - tb;
        return 0;
      }

      const tA = a.task?.scheduledTime;
      const tB = b.task?.scheduledTime;
      if (!tA && !tB) return 0;
      if (!tA) return 1;
      if (!tB) return -1;
      const [ha, ma] = tA.split(':').map((n) => Number.parseInt(n, 10));
      const [hb, mb] = tB.split(':').map((n) => Number.parseInt(n, 10));
      return ha * 60 + ma - (hb * 60 + mb);
    });
  }

  calculateSimpleOrder(targetIndex: number, sameTasks: TaskInstance[]): number {
    if (!sameTasks || sameTasks.length === 0) {
      return 100;
    }

    const working = [...sameTasks];
    const needsSeed = working.some((inst) => !Number.isFinite(inst.order as number));
    if (needsSeed) {
      this.normalizeOrdersForDrag(working);
    }

    const sorted = working.sort((a, b) => (a.order as number) - (b.order as number));
    const clampedIndex = Math.min(Math.max(targetIndex, 0), sorted.length);

    if (clampedIndex <= 0) {
      const firstOrder = sorted[0].order as number;
      return Number.isFinite(firstOrder) ? firstOrder - 100 : 100;
    }

    if (clampedIndex >= sorted.length) {
      const lastOrder = sorted[sorted.length - 1].order as number;
      return Number.isFinite(lastOrder) ? lastOrder + 100 : (sorted.length + 1) * 100;
    }

    const prevOrder = sorted[clampedIndex - 1].order as number;
    const nextOrder = sorted[clampedIndex].order as number;

    if (!Number.isFinite(prevOrder) || !Number.isFinite(nextOrder) || nextOrder - prevOrder <= 1) {
      this.normalizeOrdersForDrag(working);
      working.sort((a, b) => (a.order as number) - (b.order as number));
      const normalizedPrev = working[clampedIndex - 1]?.order as number;
      const normalizedNext = working[clampedIndex]?.order as number;
      return Math.floor(
        ((normalizedPrev ?? 0) + (normalizedNext ?? (normalizedPrev ?? 0) + 100)) / 2,
      );
    }

    return Math.floor((prevOrder + nextOrder) / 2);
  }

  private normalizeOrdersForDrag(instances: TaskInstance[]): void {
    if (!instances || instances.length === 0) {
      return;
    }

    const sorted = [...instances].sort((a, b) => {
      const orderA = Number.isFinite(a.order) ? (a.order as number) : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.order) ? (b.order as number) : Number.MAX_SAFE_INTEGER;
      if (orderA === orderB) {
        return this.getTaskTitle(a.task).localeCompare(this.getTaskTitle(b.task));
      }
      return orderA - orderB;
    });

    let cursor = 100;
    sorted.forEach((inst) => {
      inst.order = cursor;
      cursor += 100;
    });
  }

  private ensureOrdersForSlot(
    instances: TaskInstance[],
    slotKey: string,
    options: EnsureOptions,
  ): void {
    const slotInstances = instances.filter((inst) => (inst.slotKey || 'none') === slotKey);
    if (slotInstances.length === 0) {
      return;
    }

    const normalizedState = (state: TaskInstance['state']) => this.options.normalizeState(state);

    const done = slotInstances.filter((inst) => normalizedState(inst.state) === 'done');
    const running = slotInstances.filter((inst) => normalizedState(inst.state) === 'running');
    const idle = slotInstances.filter((inst) => normalizedState(inst.state) === 'idle');

    let maxOrder = 0;
    let minOrder: number | null = null;

    const trackOrder = (value: number | null | undefined) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        maxOrder = Math.max(maxOrder, value);
        minOrder = minOrder === null ? value : Math.min(minOrder, value);
      }
    };

    const assignSequential = (items: TaskInstance[], startOrder: number, step = 100) => {
      let cursor = startOrder;
      items.forEach((inst) => {
        inst.order = cursor;
        trackOrder(cursor);
        cursor += step;
      });
      return cursor;
    };

    const assignDescending = (items: TaskInstance[], startOrder: number, step = 100) => {
      let cursor = startOrder;
      items.forEach((inst) => {
        inst.order = cursor;
        trackOrder(cursor);
        cursor -= step;
      });
      return cursor;
    };

    const shouldRecomputeDone =
      options.forceDone || done.some((inst) => inst.order === undefined || inst.order === null);
    if (shouldRecomputeDone) {
      const sortedDone = [...done].sort((a, b) => {
        const ta = a.startTime ? a.startTime.getTime() : Infinity;
        const tb = b.startTime ? b.startTime.getTime() : Infinity;
        return ta - tb;
      });
      assignSequential(sortedDone, 100);
    } else {
      done.forEach((inst) => {
        trackOrder(inst.order);
      });
    }

    running.forEach((inst) => {
      trackOrder(inst.order);
    });

    const runningMissing = running.filter((inst) => inst.order === undefined || inst.order === null);
    if (runningMissing.length > 0) {
      runningMissing.sort((a, b) => (a.startTime?.getTime() ?? 0) - (b.startTime?.getTime() ?? 0));
      const start = (Number.isFinite(maxOrder) ? maxOrder : 0) + 100;
      assignSequential(runningMissing, start);
    }

    idle.forEach((inst) => {
      trackOrder(inst.order);
    });

    const idleMissing = idle.filter((inst) => inst.order === undefined || inst.order === null);
    if (idleMissing.length > 0) {
      const scheduledIdle = idleMissing.filter((candidate) => this.getScheduledMinutes(candidate.task) !== null);
      const unscheduledIdle = idleMissing.filter((candidate) => this.getScheduledMinutes(candidate.task) === null);

      if (unscheduledIdle.length > 0) {
        const sortedUnscheduled = [...unscheduledIdle].sort((a, b) => {
          const createdA = this.getCreatedMillis(a);
          const createdB = this.getCreatedMillis(b);
          const keyA = createdA ?? Number.MIN_SAFE_INTEGER;
          const keyB = createdB ?? Number.MIN_SAFE_INTEGER;
          if (keyA !== keyB) {
            return keyA - keyB;
          }
          const titleCompare = this.getTaskTitle(a.task).localeCompare(this.getTaskTitle(b.task));
          if (titleCompare !== 0) {
            return titleCompare;
          }
          return (a.instanceId ?? '').localeCompare(b.instanceId ?? '');
        });

        const startingOrder = minOrder !== null ? minOrder - 100 : 100;
        assignDescending(sortedUnscheduled, startingOrder);
      }

      if (scheduledIdle.length > 0) {
        const sortedScheduled = [...scheduledIdle].sort((a, b) => {
          const minutesA = this.getScheduledMinutes(a.task);
          const minutesB = this.getScheduledMinutes(b.task);
          if (minutesA === null && minutesB === null) {
            return this.getTaskTitle(a.task).localeCompare(this.getTaskTitle(b.task));
          }
          if (minutesA === null) return 1;
          if (minutesB === null) return -1;
          return minutesA - minutesB;
        });

        const start = (Number.isFinite(maxOrder) ? maxOrder : 0) + 100;
        assignSequential(sortedScheduled, start);
      }
    }
  }
}

export default TaskOrderManager;
