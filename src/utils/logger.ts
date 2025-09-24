import { Notice } from 'obsidian';

type ConsoleMethod = (...params: unknown[]) => void;

export class Logger {
  static log(level: string = 'log', ...args: unknown[]): void {
    try {
      const target = (console as Record<string, ConsoleMethod | undefined>)[level];
      target?.(...args);
    } catch {}
  }

  static notify(message: string, timeout?: number): void {
    try {
      new Notice(message, timeout);
    } catch {
      this.log('warn', '[Notice]', message);
    }
  }
}
