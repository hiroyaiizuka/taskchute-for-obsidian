import type { Page } from "@playwright/test"

/**
 * The [major, minor] of the Obsidian app running in the page. The user agent
 * names the installer's version instead, which on macOS and Windows is not
 * the app the suite puts in front of it (see ensureAppAsar).
 */
export async function obsidianAppVersion(page: Page): Promise<[number, number]> {
  const raw = await page.evaluate(() => {
    const electron = (window as unknown as {
      require(id: "electron"): { ipcRenderer: { sendSync(channel: "version"): string } }
    }).require("electron")
    return electron.ipcRenderer.sendSync("version").match(/^(\d+)\.(\d+)/)?.slice(1) ?? ["0", "0"]
  })
  return [Number(raw[0]), Number(raw[1])]
}

/** Bases has the kanban view from Obsidian 1.14. */
export const hasBasesKanban = ([major, minor]: [number, number]): boolean =>
  major > 1 || (major === 1 && minor >= 14)
