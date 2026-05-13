import 'obsidian'
import { TaskInstance } from "../types";

export interface TimerServiceOptions {
  getRunningInstances: () => TaskInstance[];
  onTick: (inst: TaskInstance) => void;
  intervalMs?: number;
}

export class TimerService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private intervalWindow: Window | null = null;
  private readonly getRunningInstances: () => TaskInstance[];
  private readonly onTick: (inst: TaskInstance) => void;
  private readonly intervalMs: number;

  constructor(opts: TimerServiceOptions) {
    this.getRunningInstances = opts.getRunningInstances;
    this.onTick = opts.onTick;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  start(): void {
    if (this.interval !== null) return;
    this.intervalWindow = activeWindow;
    this.interval = this.intervalWindow.setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.interval === null) return;

    const interval = this.interval;
    const intervalWindow = this.intervalWindow ?? activeWindow;
    this.interval = null;
    this.intervalWindow = null;
    intervalWindow.clearInterval(interval);
  }

  restart(): void {
    this.stop();
    this.start();
  }

  dispose(): void {
    this.stop();
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  private tick(): void {
    const running = this.getRunningInstances() || [];
    if (running.length === 0) {
      // Auto-stop when nothing is running
      this.stop();
      return;
    }
    for (const inst of running) {
      try { this.onTick(inst); } catch { /* noop */ }
    }
  }
}
