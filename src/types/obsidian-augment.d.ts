import 'obsidian';

declare module 'obsidian' {
  interface App {
    commands: {
      removeCommand(id: string): void
      executeCommandById?(id: string): boolean | void
      [key: string]: unknown
    }
    setting?: {
      open(): void
      openTabById(id: string): void
      openTab?(tabId: string): void
      [key: string]: unknown
    }
  }
}
