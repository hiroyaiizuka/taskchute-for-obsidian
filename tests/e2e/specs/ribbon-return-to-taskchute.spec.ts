import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"

// LEV-410: going back to an existing TaskChute tab from the ribbon used to
// only bring that tab to the front. The tab the user came from stayed the
// current one, hidden behind TaskChute, so the next note opened from the
// ribbon went into that hidden tab and the screen did not change.

interface Screen {
  /** View type of the main-area tab on screen. */
  shown: string | undefined
  shownFile: string | null
  /** Whether Obsidian's current leaf is the one on screen. */
  activeOnScreen: boolean
}

async function screen(page: Page): Promise<Screen> {
  return page.evaluate(() => {
    const workspace = window.app.workspace as unknown as {
      activeLeaf: { containerEl: HTMLElement } | null
      iterateRootLeaves(cb: (leaf: { containerEl: HTMLElement; view: { getViewType(): string; file?: { path: string } } }) => void): void
    }
    let shown: string | undefined
    let shownFile: string | null = null
    workspace.iterateRootLeaves((leaf) => {
      if (leaf.containerEl.offsetParent) {
        shown = leaf.view.getViewType()
        shownFile = leaf.view.file?.path ?? null
      }
    })
    return { shown, shownFile, activeOnScreen: !!workspace.activeLeaf?.containerEl.offsetParent }
  })
}

async function clickRibbon(page: Page, label: RegExp): Promise<void> {
  await page.locator(".side-dock-ribbon-action").first().waitFor()
  const labels = await page.locator(".side-dock-ribbon-action").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))
  const match = labels.find((text) => label.test(text))
  if (!match) throw new Error(`No ribbon action matches ${label}: ${labels.join(" | ")}`)
  await page.locator(`.side-dock-ribbon-action[aria-label="${match}"]`).click()
}

test("the ribbon returns to TaskChute so the next daily note shows up", async ({ obsidian }) => {
  const { page } = obsidian
  await page.evaluate(async () => {
    const app = window.app as unknown as {
      internalPlugins: { getPluginById(id: string): { enable(save: boolean): Promise<void> } }
    }
    await app.internalPlugins.getPluginById("daily-notes").enable(true)
  })
  // The core plugin's default name is today's YYYY-MM-DD, read in Obsidian.
  const dailyFile = await page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`
  })

  await clickRibbon(page, /daily note/i)
  await expect.poll(async () => (await screen(page)).shownFile).toBe(dailyFile)

  await clickRibbon(page, /taskchute/i)
  await expect.poll(async () => (await screen(page)).shown).toBe("taskchute-view")

  // Twice: the first round creates the tabs, the second returns to them.
  for (let round = 0; round < 2; round += 1) {
    await clickRibbon(page, /daily note/i)
    await expect.poll(async () => (await screen(page)).shownFile).toBe(dailyFile)

    await clickRibbon(page, /taskchute/i)
    await expect.poll(async () => (await screen(page)).shown).toBe("taskchute-view")
    expect((await screen(page)).activeOnScreen).toBe(true)
  }

  await clickRibbon(page, /daily note/i)
  await expect.poll(async () => (await screen(page)).shownFile).toBe(dailyFile)
})
