import { expect, test } from "../fixtures"

const PLUGIN_ID = "taskchute-plus"

const COMMAND_IDS = [
  "open-taskchute-view",
  "taskchute-settings",
  "show-today-tasks",
  "reorganize-idle-tasks",
  "leave-comment",
  "duplicate-selected-task",
  "delete-selected-task",
  "reset-selected-task",
].map((id) => `${PLUGIN_ID}:${id}`)

test("loads the plugin outside restricted mode", async ({ obsidian }) => {
  const state = await obsidian.page.evaluate((id) => ({
    communityPluginsEnabled: window.app.plugins.isEnabled(),
    loaded: id in window.app.plugins.plugins,
  }), PLUGIN_ID)

  expect(state).toEqual({ communityPluginsEnabled: true, loaded: true })
  // The "Do you trust the author of this vault?" prompt must not be up.
  await expect(obsidian.page.locator(".modal-container")).toHaveCount(0)
})

test("registers its commands", async ({ obsidian }) => {
  const registered = await obsidian.page.evaluate(
    (prefix) => Object.keys(window.app.commands.commands).filter((id) => id.startsWith(prefix)),
    `${PLUGIN_ID}:`,
  )

  expect(registered.sort()).toEqual([...COMMAND_IDS].sort())
})

test("opens the TaskChute view", async ({ obsidian }) => {
  const { page } = obsidian
  await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)

  await expect(page.locator(".taskchute-view-root")).toBeVisible()
  // The day is split into these slots even when there are no tasks.
  for (const slot of ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]) {
    await expect(page.locator(".taskchute-view-root").getByText(slot, { exact: true })).toBeVisible()
  }
  expect(await page.evaluate(() => window.app.workspace.getLeavesOfType("taskchute-view").length)).toBe(1)
})

test("opens its settings tab", async ({ obsidian }) => {
  const { page } = obsidian
  await page.evaluate((id) => {
    window.app.setting.open()
    window.app.setting.openTabById(id)
  }, PLUGIN_ID)

  // Obsidian 1.13 opens settings in a popout window, so read the tab through
  // the settings object rather than the main window's DOM.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tab = window.app.setting.activeTab
        return {
          id: tab?.id,
          attached: tab?.containerEl.isConnected ?? false,
          rendersSettings: (tab?.containerEl.querySelectorAll(".setting-item").length ?? 0) > 0,
        }
      }),
    )
    .toEqual({ id: PLUGIN_ID, attached: true, rendersSettings: true })
  await page.evaluate(() => window.app.setting.close())
})

// The plugin follows Obsidian's language (#188): command names and the view
// both switch with it.
for (const { language, openView, today } of [
  { language: "en", openView: "Open TaskChute", today: /Today/ },
  { language: "ja", openView: "TaskChuteを開く", today: /今日/ },
] as const) {
  test.describe(`in ${language}`, () => {
    test.use({ language })

    test("localizes commands and the view", async ({ obsidian }) => {
      const { page } = obsidian
      const name = await page.evaluate(
        (id) => window.app.commands.commands[id]?.name,
        `${PLUGIN_ID}:open-taskchute-view`,
      )
      expect(name).toBe(`TaskChute Plus: ${openView}`)

      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)
      await expect(page.locator(".taskchute-view-root")).toContainText(today)
    })
  })
}
