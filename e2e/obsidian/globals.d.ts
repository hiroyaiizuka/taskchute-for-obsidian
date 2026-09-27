// The slice of Obsidian's runtime `window.app` the suite reads inside
// page.evaluate(). Much of it (plugins, commands, setting) is internal API that
// the public `obsidian` typings do not declare.
interface E2ECommand {
  id: string
  name: string
}

interface E2EObsidianApp {
  vault: {
    adapter: { basePath: string }
    getName(): string
  }
  workspace: {
    layoutReady: boolean
    getLeavesOfType(type: string): unknown[]
  }
  plugins: {
    isEnabled(): boolean
    plugins: Record<string, unknown>
    disablePlugin(id: string): Promise<void>
  }
  commands: {
    commands: Record<string, E2ECommand>
    executeCommandById(id: string): boolean
  }
  setting: {
    activeTab: { id: string; containerEl: HTMLElement } | null
    open(): void
    openTabById(id: string): void
    close(): void
  }
}

interface Window {
  app: E2EObsidianApp
}
