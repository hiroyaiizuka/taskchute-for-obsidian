import { TaskInstance } from "../types";

export interface TimerServiceOptions {
  getRunningInstances: () => TaskInstance[];
  onTick: (inst: TaskInstance) => void;
  intervalMs?: number;
}

export class TimerService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly getRunningInstances: () => TaskInstance[];
  private readonly onTick: (inst: TaskInstance) => void;
  private readonly intervalMs: number;

  constructor(opts: TimerServiceOptions) {
    this.getRunningInstances = opts.getRunningInstances;
    this.onTick = opts.onTick;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  dispose(): void {
    this.stop();
  }

  isRunning(): boolean {
    return !!this.interval;
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
