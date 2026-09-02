import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian"
import { checkSeatRegistration } from "../features/license/ui/notifySeatReleased"
import type { PluginWithSettings } from "./pluginWithSettings"
import { ProUnlockState } from "./proUnlockState"
import { everydaySections, trailingSections } from "./sections"
import { advancedSection } from "./sections/advanced"
import { SectionBoundaryDraft } from "./sections/advanced/sectionBoundaryDraft"
import { proSection } from "./sections/pro"
import { LicenseActivationState } from "./sections/pro/licenseActivationState"
import type {
  AnyControlHandler,
  SectionContext,
  SectionModule,
} from "./types"
import { AiTaskToggleGuard } from "./services/aiTaskLifecycle"

/**
 * The settings tab.
 *
 * Every setting is declared in a section module under ./sections; this class
 * only composes them, routes reads and writes to their handlers, and holds the
 * few pieces of state that have to survive a rebuild of the definitions.
 */
export class TaskChuteSettingTab extends PluginSettingTab {
  plugin: PluginWithSettings
  /** Rejects an older async toggle completion after a newer operation wins. */
  private readonly aiTaskToggleGuard = new AiTaskToggleGuard()
  private readonly proUnlock = new ProUnlockState()
  private readonly licenseForm = new LicenseActivationState()
  /**
   * Held by the tab, not by a render pass: adding or removing a boundary
   * rebuilds the definitions, and a draft re-seeded on every rebuild would
   * discard the edit that triggered it.
   */
  private readonly boundaryDraft = new SectionBoundaryDraft()
  /**
   * Whether the next definition build is someone arriving at the screen rather
   * than a rebuild of it.
   *
   * There is no "opened" hook to use: display() is not called for a tab that
   * returns definitions, and getSettingDefinitions() serves the search index,
   * every control change and every update() alike. hide() is the one event that
   * separates visits, so it arms this; the first build of all is armed too,
   * because that one happens as the plugin loads and its answer is what the
   * screen shows moments later.
   */
  private licenseSyncDue = true
  /**
   * Set while the rebuild below is one this tab asked for.
   *
   * update() runs getSettingDefinitions() again, so a sync that redraws would
   * start a sync that redraws. One piece of news is worth exactly one redraw,
   * and this is what holds it to that — a comparison would not: it only ends
   * the loop if the manager already agrees with the answer it just gave.
   */
  private licenseSyncSuppressed = false

  private readonly ctx: SectionContext
  private readonly modules: SectionModule[]
  /**
   * Built here rather than while assembling definitions: getSettingDefinitions()
   * is also called for search indexing, and getControlValue() runs on every
   * control render, so a map filled in as a side effect of building items would
   * miss the earliest reads.
   */
  private readonly handlers: Record<string, AnyControlHandler>
  private readonly prefixHandlers: Record<
    string,
    (suffix: string) => AnyControlHandler | undefined
  >

  constructor(app: App, plugin: PluginWithSettings) {
    super(app, plugin)
    this.plugin = plugin
    this.containerEl.addClass("taskchute-settings-pane")
    this.ctx = {
      app,
      plugin,
      update: () => {
        this.update()
      },
      refreshDomState: () => {
        this.refreshDomState()
      },
    }
    this.modules = [
      ...everydaySections(),
      advancedSection(this.boundaryDraft),
      proSection(this.proUnlock, this.licenseForm, this.aiTaskToggleGuard),
      ...trailingSections(this.proUnlock),
    ]
    this.handlers = Object.assign(
      {},
      ...this.modules.map((module) => module.handlers ?? {}),
    ) as Record<string, AnyControlHandler>
    this.prefixHandlers = Object.assign(
      {},
      ...this.modules.map((module) => module.prefixHandlers ?? {}),
    ) as Record<string, (suffix: string) => AnyControlHandler | undefined>
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // Arriving at the screen is the moment someone is most likely to wonder
    // whether they are still Pro — after activating on another machine, or
    // after releasing this device from one. Settle it against the server, and
    // skip the throttle for the arrival itself; the rebuilds that follow it
    // take the throttled path, so a burst of control changes costs nothing.
    if (!this.licenseSyncSuppressed) {
      const force = this.licenseSyncDue
      this.licenseSyncDue = false

      void checkSeatRegistration(this.plugin, { force }).then((result) => {
        // The runtime is torn down by the license listener in main.ts; only the
        // definitions this tab drew from the old state still need replacing.
        // Any change, not just a released seat: an activation that landed
        // elsewhere leaves this screen just as wrong.
        if (!result.changed) return

        this.licenseSyncSuppressed = true
        try {
          this.update()
        } finally {
          this.licenseSyncSuppressed = false
        }
      })
    }

    return this.modules.flatMap((module) => module.items(this.ctx))
  }

  /**
   * Closing the tab abandons any boundary edit that was never applied, so the
   * next visit starts from what is actually in effect.
   */
  hide(): void {
    this.boundaryDraft.reseed(this.plugin.settings.customSections)
    this.licenseForm.reset()
    // The next build is a fresh visit rather than a rebuild of this one.
    this.licenseSyncDue = true
    super.hide()
  }

  getControlValue(key: string): unknown {
    const handler = this.resolveHandler(key)
    return handler ? handler.read(this.ctx) : super.getControlValue(key)
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const handler = this.resolveHandler(key)
    if (!handler) {
      await super.setControlValue(key, value)
      return
    }
    await handler.write(value, this.ctx)
  }

  /**
   * Exact keys first, then the dotted prefixes used by rows whose count is not
   * known until render time.
   */
  private resolveHandler(key: string): AnyControlHandler | undefined {
    const exact = this.handlers[key]
    if (exact) return exact
    const dot = key.indexOf(".")
    if (dot < 0) return undefined
    return this.prefixHandlers[key.slice(0, dot)]?.(key.slice(dot + 1))
  }
}
