import type { Page } from "@playwright/test"
import { PLUGIN_ID } from "./paths"

// Terminal runs live in a broker that Obsidian starts outside its own process
// group, so killing Obsidian leaves the broker and its shells running. Left
// alone they end by themselves a while later, overlapping the next tests.

const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Shut the AI runtime down the way quitting Obsidian does: running AI tasks
 * stop and the broker is asked to exit. Does nothing when AI tasks are off.
 */
export async function shutDownAiRuntime(page: Page): Promise<void> {
  await page
    .evaluate(
      async ([id, timeoutMs]) => {
        const plugin = window.app.plugins.plugins[id] as { aiTaskManager?: { disposeAndWait(): Promise<void> } } | undefined
        const manager = plugin?.aiTaskManager
        if (!manager) return
        await Promise.race([
          manager.disposeAndWait().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ])
      },
      [PLUGIN_ID, SHUTDOWN_TIMEOUT_MS] as const,
    )
    .catch(() => undefined)
}
