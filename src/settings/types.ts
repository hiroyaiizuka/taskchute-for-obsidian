import type { App, SettingDefinitionItem } from "obsidian"
import type { PluginWithSettings } from "./pluginWithSettings"

/**
 * What a section factory is allowed to reach.
 *
 * `update` and `refreshDomState` are the two ways a section reacts to its own
 * changes, and the choice between them matters:
 *
 * - `refreshDomState()` re-evaluates every `visible` and `disabled` predicate
 *   and applies the result in place. Use it when only a predicate flipped —
 *   the definition tree is unchanged. It does NOT re-run `render:` callbacks.
 * - `update()` rebuilds the definitions. Use it when an item's identity, count,
 *   `name` or `desc` changed, or when a `render:` callback has to run again.
 */
export interface SectionContext {
  readonly app: App
  readonly plugin: PluginWithSettings
  readonly update: () => void
  readonly refreshDomState: () => void
}

/**
 * The missing onChange.
 *
 * Declarative controls have no per-control callback: every write arrives at the
 * tab's `setControlValue(key, value)`. A handler owns one key's read,
 * normalization, persistence and side effects, and lives next to the section
 * that declares the control rather than in a switch on the tab.
 */
export interface ControlHandler<V = unknown> {
  /** Value the control displays. Undefined falls back to `defaultValue`. */
  read(ctx: SectionContext): V | undefined
  /** Persists and reacts. Responsible for calling saveSettings() itself. */
  write(value: V, ctx: SectionContext): void | Promise<void>
}

/**
 * A handler of unknown value type. `read`/`write` are declared as methods, so
 * TypeScript compares their parameters bivariantly and a `ControlHandler<string>`
 * still fits here — which is what lets one map hold handlers of every control
 * type.
 */
export type AnyControlHandler = ControlHandler<unknown>

/**
 * Handlers for keys that are only known at render time — the boundary rows,
 * whose count the user controls. Keyed by the part before the first dot; the
 * factory receives the part after it.
 */
export type PrefixHandlerMap = Readonly<
  Record<string, (suffix: string) => AnyControlHandler | undefined>
>

export interface SectionModule {
  /** Rebuilt on every render, so predicates and computed text stay current. */
  items(ctx: SectionContext): SettingDefinitionItem[]
  /**
   * Built once, in the tab's constructor. `getSettingDefinitions()` is also
   * called for search indexing before the first render, so a handler map
   * populated as a side effect of building items would miss early reads.
   */
  handlers?: Readonly<Record<string, AnyControlHandler>>
  prefixHandlers?: PrefixHandlerMap
}
