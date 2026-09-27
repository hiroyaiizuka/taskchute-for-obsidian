import { expect, test } from "../fixtures"

const PLUGIN_ID = "taskchute-plus"

// #105: the plugin's stylesheet used to hide every `.is-hidden` element in
// Obsidian, which broke switching between stacked tabs. Obsidian's own
// elements must look the same with the plugin on and off.
test("does not restyle Obsidian's own is-hidden elements", async ({ obsidian }) => {
  const { page } = obsidian
  const displayOfCoreIsHidden = () =>
    page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("div"))
      probe.className = "is-hidden"
      const display = getComputedStyle(probe).display
      probe.remove()
      return display
    })

  const withPlugin = await displayOfCoreIsHidden()
  await page.evaluate((id) => window.app.plugins.disablePlugin(id), PLUGIN_ID)
  const withoutPlugin = await displayOfCoreIsHidden()

  expect(withPlugin).toBe(withoutPlugin)
})
