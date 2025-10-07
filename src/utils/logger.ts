import { Notice } from 'obsidian';

type ConsoleMethod = (...params: unknown[]) => void;

export class Logger {
  static log(level: string = 'log', ...args: unknown[]): void {
    try {
      const record = console as unknown as Record<string, ConsoleMethod | undefined>
      const normalizedLevel = typeof level === 'string' ? level : String(level)
      const target = record[normalizedLevel] ?? record[normalizedLevel.toLowerCase()]
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
