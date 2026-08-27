import { Notice, TFile, TFolder } from "obsidian"
import type { TaskChuteSettings } from "../types"
import type { ControlHandler, SectionContext } from "./types"

/**
 * Shared shapes for the handlers sections register. Each one keeps the reading
 * and writing of a single setting in one place, so a section file reads as a
 * list of settings rather than a list of callbacks.
 */

/**
 * A whole number with a floor.
 *
 * Deliberately does not correct the text the user typed: the stored value is
 * clamped while the input keeps whatever was entered, matching how these fields
 * have always behaved. Clamping belongs here rather than in a control's
 * `validate`, which rejects a change instead of adjusting it.
 */
export function clampedNumber(options: {
  read: (settings: TaskChuteSettings) => number | undefined
  write: (settings: TaskChuteSettings, value: number) => void
  min: number
  fallback: number
  after?: (ctx: SectionContext) => void | Promise<void>
}): ControlHandler<number> {
  return {
    read: (ctx) => options.read(ctx.plugin.settings) ?? options.fallback,
    write: async (value, ctx) => {
      const normalized = Number.isFinite(value)
        ? Math.max(options.min, Math.round(value))
        : options.fallback
      options.write(ctx.plugin.settings, normalized)
      await ctx.plugin.saveSettings()
      await options.after?.(ctx)
    },
  }
}

export function toggle(options: {
  read: (settings: TaskChuteSettings) => boolean | undefined
  write: (settings: TaskChuteSettings, value: boolean) => void
  after?: (value: boolean, ctx: SectionContext) => void | Promise<void>
}): ControlHandler<boolean> {
  return {
    read: (ctx) => options.read(ctx.plugin.settings) ?? false,
    write: async (value, ctx) => {
      options.write(ctx.plugin.settings, value)
      await ctx.plugin.saveSettings()
      await options.after?.(value, ctx)
    },
  }
}

/**
 * A dropdown whose stored value is narrowed to a known set. `normalize` also
 * supplies the fallback, so an absent or unrecognised stored value resolves to
 * the same option the user would see selected.
 */
export function choice<V extends string>(options: {
  read: (settings: TaskChuteSettings) => V | undefined
  write: (settings: TaskChuteSettings, value: V) => void
  normalize: (raw: string) => V
  after?: (value: V, ctx: SectionContext) => void | Promise<void>
}): ControlHandler<string> {
  return {
    read: (ctx) => options.normalize(options.read(ctx.plugin.settings) ?? ""),
    write: async (raw, ctx) => {
      const value = options.normalize(raw)
      options.write(ctx.plugin.settings, value)
      await ctx.plugin.saveSettings()
      await options.after?.(value, ctx)
    },
  }
}

export function text(options: {
  read: (settings: TaskChuteSettings) => string | undefined
  write: (settings: TaskChuteSettings, value: string) => void
  after?: (value: string, ctx: SectionContext) => void | Promise<void>
}): ControlHandler<string> {
  return {
    read: (ctx) => options.read(ctx.plugin.settings) ?? "",
    write: async (value, ctx) => {
      options.write(ctx.plugin.settings, value)
      await ctx.plugin.saveSettings()
      await options.after?.(value, ctx)
    },
  }
}

/**
 * A vault path.
 *
 * The file and folder controls always hand over a string, but the settings use
 * three different empty representations, so each field states its own. A path
 * that is well-formed but does not exist yet is still saved — the user may be
 * naming a folder they are about to create — and only draws a notice; only a
 * malformed path is refused, which the control's `validate` handles.
 */
export function vaultPath<E extends null | undefined | "">(options: {
  read: (settings: TaskChuteSettings) => string | null | undefined
  write: (settings: TaskChuteSettings, value: string | E) => void
  empty: E
  kind: "file" | "folder"
  missingNotice: (path: string) => string
}): ControlHandler<string> {
  return {
    read: (ctx) => options.read(ctx.plugin.settings) ?? "",
    write: async (raw, ctx) => {
      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        options.write(ctx.plugin.settings, options.empty)
        await ctx.plugin.saveSettings()
        return
      }
      options.write(ctx.plugin.settings, trimmed)
      await ctx.plugin.saveSettings()
      if (!vaultPathExists(ctx, trimmed, options.kind)) {
        new Notice(options.missingNotice(trimmed))
      }
    },
  }
}

function vaultPathExists(
  ctx: SectionContext,
  path: string,
  kind: "file" | "folder",
): boolean {
  const entry = ctx.app.vault.getAbstractFileByPath(path)
  return kind === "file" ? entry instanceof TFile : entry instanceof TFolder
}

/**
 * Rejects a path the vault could never hold. Returned as the control's
 * `validate`, so the change never reaches the handler.
 */
export function validateVaultPath(
  ctx: SectionContext,
  value: string,
): string | undefined {
  if (value.trim().length === 0) return undefined
  const result = ctx.plugin.pathManager.validatePath(value.trim())
  return result.valid ? undefined : result.error
}
