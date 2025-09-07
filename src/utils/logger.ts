import { Notice } from 'obsidian';

export class Logger {
  static log(level: string = 'log', ...args: any[]): void {
    try {
      (console as any)[level]?.(...args);
    } catch (_) {}
  }

  static notify(message: string, timeout?: number): void {
    try {
      new Notice(message, timeout);
    } catch (_) {
      this.log('warn', '[Notice]', message);
    }
  }
}