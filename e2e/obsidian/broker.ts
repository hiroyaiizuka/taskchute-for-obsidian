import type { Page } from "@playwright/test"
import { PLUGIN_ID } from "./paths"

// Terminal runs live in a broker that Obsidian starts outside its own process
// group, so killing Obsidian leaves the broker and its shells running. Left
// alone they end by themselves a while later, overlapping the next tests.

const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Shut the AI runtime down the way quitting Obsidian does: running AI tasks
 * stop and the broker is asked to exit. Covers managers still shutting down
 * after AI tasks were switched off. Does nothing when AI tasks were never on.
 *
 * The time limit is kept here, not in the window, so a hung window cannot
 * keep the caller from killing Obsidian.
 */
export async function shutDownAiRuntime(page: Page): Promise<void> {
  const shutdown = page
    .evaluate(async (id) => {
      type Manager = { disposeAndWait(): Promise<void> }
      const plugin = window.app.plugins.plugins[id] as
        | { aiTaskManager?: Manager; aiTaskManagersPendingDisposal?: Set<Manager> }
        | undefined
      const managers = new Set<Manager>(plugin?.aiTaskManagersPendingDisposal ?? [])
      if (plugin?.aiTaskManager) managers.add(plugin.aiTaskManager)
      await Promise.allSettled(Array.from(managers, (manager) => manager.disposeAndWait()))
    }, PLUGIN_ID)
    .catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
  })
  await Promise.race([shutdown, deadline])
  clearTimeout(timer)
}
