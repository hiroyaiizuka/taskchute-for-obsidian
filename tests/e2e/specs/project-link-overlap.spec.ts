import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, taskRow, todayKey } from "../helpers/aiTask"

// LEV-414: a long project name filled the project box with the name alone and
// pushed the link icon out of it, under the start time beside it. Clicking the
// icon then picked the start time.

async function createNote(page: Page, file: string, data: string): Promise<void> {
  await page.evaluate(
    async ([target, body]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(p: string): unknown
        createFolder(p: string): Promise<unknown>
        create(p: string, d: string): Promise<unknown>
      }
      const folder = target.slice(0, target.lastIndexOf("/"))
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(target, body)
    },
    [file, data] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as { metadataCache: { getCache(path: string): { frontmatter?: unknown } | null } }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, file)
}

test("a long project name leaves the link icon clear of the start time", async ({ obsidian }) => {
  const { page } = obsidian
  await page.setViewportSize({ width: 1300, height: 800 }).catch(() => undefined)
  await page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
    plugin.settings.projectsFolder = "Projects"
  }, PLUGIN_ID)
  const project = "マーケAI全自動化、10X集客の仕組みを作る大きなプロジェクト"
  await createNote(page, `Projects/Project - ${project}.md`, "---\nstatus: todo\n---\n")
  const taskPath = `${TASK_FOLDER}/10X戦略をAddnessで組む.md`
  await createNote(
    page,
    taskPath,
    `---\ntags:\n  - task\ntarget_date: "${await todayKey(page)}"\nproject: "[[Project - ${project}]]"\n---\n`,
  )
  await openTaskChute(page)

  const row = taskRow(page, taskPath)
  await row.locator(".play-stop-button").click()
  await expect(row.locator(".task-time-start")).toHaveText(/\d{2}:\d{2}/)

  const layout = await row.evaluate((el) => {
    const rect = (sel: string) => el.querySelector(sel)!.getBoundingClientRect()
    const link = rect(".taskchute-external-link")
    const box = rect(".taskchute-project-display")
    const time = rect(".task-time-range")
    const name = el.querySelector(".taskchute-project-name") as HTMLElement
    const hit = document.elementFromPoint(link.left + link.width / 2, link.top + link.height / 2)
    return {
      linkInsideBox: link.right <= box.right + 0.5,
      linkBeforeTime: link.right <= time.left,
      hitIsLink: !!hit?.closest(".taskchute-external-link"),
      nameEllipsised: name.scrollWidth > name.clientWidth,
    }
  })
  expect(layout).toEqual({ linkInsideBox: true, linkBeforeTime: true, hitIsLink: true, nameEllipsised: true })
})
