import { expect, test } from "../fixtures"

// LEV-408: Hearth's plugin-view card hosts a view in a detached leaf and
// rebuilds it whenever the metadata cache settles. Opening the TaskChute view
// used to write a note every time, which settled the cache again, so the view
// was rebuilt dozens of times a second. This host does what Hearth does,
// without depending on Hearth itself.
test("a host that rebuilds the view on every note change settles", async ({ obsidian }) => {
  const { page } = obsidian

  const result = await page.evaluate(async () => {
    const app = window.app as unknown as {
      workspace: { getLeaf(split: boolean): { constructor: unknown } }
      metadataCache: { on(name: string, cb: () => void): unknown; offref(ref: unknown): void }
      vault: { on(name: string, cb: (file: { path: string }) => void): unknown; offref(ref: unknown): void }
    }
    type Leaf = { containerEl: HTMLElement; setViewState(state: object): Promise<void>; detach(): void }
    const LeafCtor = app.workspace.getLeaf(false).constructor as new (a: unknown) => Leaf

    const host: HTMLDivElement = document.createElement("div")
    host.style.cssText = "position: fixed; inset: 0; z-index: 9999"
    document.body.appendChild(host)
    let leaf: Leaf | null = null
    let mounts = 0
    const mount = () => {
      if (leaf) {
        const old = leaf
        void old.setViewState({ type: "empty" }).then(() => old.detach())
      }
      leaf = new LeafCtor(app)
      host.appendChild(leaf.containerEl)
      mounts += 1
      void leaf.setViewState({ type: "taskchute-view", active: false })
    }

    const writes: string[] = []
    const resolvedRef = app.metadataCache.on("resolved", mount)
    const modifyRef = app.vault.on("modify", (file) => writes.push(file.path))

    mount()
    await new Promise((resolve) => setTimeout(resolve, 3000))

    app.metadataCache.offref(resolvedRef)
    app.vault.offref(modifyRef)
    const rendered = host.querySelectorAll(".taskchute-view-root").length
    const last = leaf as Leaf | null
    if (last) await last.setViewState({ type: "empty" })
    last?.detach()
    host.remove()
    return { mounts, writes: writes.length, rendered }
  })

  expect(result.rendered).toBe(1)
  // The first open may record today's total once; after that nothing changes,
  // so the host has no reason to rebuild more than a couple of times.
  expect(result.mounts).toBeLessThanOrEqual(3)
  expect(result.writes).toBeLessThanOrEqual(3)
})
