import fs from "node:fs"
import path from "node:path"
import { expect, test } from "../fixtures"

const PLUGIN_ID = "taskchute-plus"
const CODE = "TEST-E2E0-CODE"

const syncedCode = (dataFile: string): string | undefined =>
  (JSON.parse(fs.readFileSync(dataFile, "utf8")) as { licenseCode?: string }).licenseCode

// LEV-389: the activation code is kept on this device, not in the plugin's
// data.json, which a vault syncs. A code an older version left in data.json
// moves onto the device when the plugin loads, and leaves data.json.
test("a license code left in the synced settings moves onto this device", async ({ obsidian }) => {
  const { page } = obsidian
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  const dataFile = path.join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json")

  // What an older version saved.
  await page.evaluate(
    async ([id, code]) => {
      const plugin = window.app.plugins.plugins[id] as {
        settings: Record<string, unknown>
        saveSettings(): Promise<void>
      }
      plugin.settings.licenseCode = code
      await plugin.saveSettings()
    },
    [PLUGIN_ID, CODE] as const,
  )
  expect(syncedCode(dataFile)).toBe(CODE)

  // Load the plugin again, as an update does.
  await page.evaluate(async (id) => {
    const plugins = window.app.plugins as unknown as {
      disablePlugin(id: string): Promise<void>
      enablePlugin(id: string): Promise<void>
    }
    await plugins.disablePlugin(id)
    await plugins.enablePlugin(id)
  }, PLUGIN_ID)
  await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), PLUGIN_ID)

  await expect
    .poll(() => syncedCode(dataFile), { timeout: 10_000 })
    .toBeUndefined()
  const onDevice = await page.evaluate(() => window.localStorage.getItem("taskchute-plus.license-code"))
  expect(onDevice === null ? null : JSON.parse(onDevice)).toEqual({ code: CODE })
})
