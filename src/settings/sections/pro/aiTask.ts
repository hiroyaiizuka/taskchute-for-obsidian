import { Notice } from "obsidian"
import type { Setting, SettingDefinitionRender } from "obsidian"
import { t } from "@/i18n"
import { ElectronDirectoryPicker } from "@/features/ai-task/services/ElectronDirectoryPicker"
import { listAiAgents, type AiCliPathSettingKey } from "@/features/ai-task/agents"
import { DEFAULT_SETTINGS } from "@/settings/defaults"
import { clampedNumber } from "@/settings/controlHandlers"
import {
  AiTaskToggleGuard,
  handleAiTaskEnabledToggle,
} from "@/settings/services/aiTaskLifecycle"
import type {
  AnyControlHandler,
  SectionContext,
  SectionModule,
} from "@/settings/types"

/**
 * On Windows these launch through a shim that swallows the child process, so a
 * run started from one can never be stopped. Rejected outright rather than
 * failing later at launch.
 */
function isUnsupportedWindowsCliShim(path: string): boolean {
  return /\.(?:bat|cmd|ps1)$/iu.test(path)
}

interface CliPath {
  key: AiCliPathSettingKey
  name: string
  desc: string
}

/** One CLI path row per agent, in the order the agents are listed. */
function cliPaths(): CliPath[] {
  return listAiAgents().map(({ pathSetting }) => ({
    key: pathSetting.key,
    name: t(pathSetting.name.key, pathSetting.name.fallback),
    desc: t(pathSetting.desc.key, pathSetting.desc.fallback),
  }))
}

function cliPathHandler(path: CliPath): AnyControlHandler {
  return {
    read: (ctx) => ctx.plugin.settings[path.key] ?? "",
    write: async (value, ctx) => {
      const normalized = String(value).trim()
      const rejected = isUnsupportedWindowsCliShim(normalized)
      if (rejected) {
        new Notice(
          t(
            "settings.aiTask.pathShimUnsupported",
            "Windows .cmd/.bat/.ps1 shims cannot be used as manual CLI paths. Leave this empty for auto-detection or select the actual executable/package entrypoint.",
          ),
        )
      }
      ctx.plugin.settings[path.key] = rejected ? "" : normalized
      await ctx.plugin.saveSettings()
      // The locator caches the resolved binary, so a new path has to invalidate
      // it or the next run still uses the old one.
      ctx.plugin.aiTaskManager?.invalidateBinaryCache()
      // Rebuild so a rejected shim visibly clears the field.
      if (rejected) ctx.update()
    },
  }
}

async function browseForCliPath(
  ctx: SectionContext,
  path: CliPath,
): Promise<void> {
  const selected = await new ElectronDirectoryPicker().selectFile({
    defaultPath: ctx.plugin.settings[path.key] ?? "",
    title: path.name,
  })
  if (!selected) return
  await cliPathHandler(path).write(selected, ctx)
  ctx.update()
}

/**
 * Rendered imperatively rather than declared: a `control` row cannot also carry
 * an action, and the picker belongs beside its field rather than on a row of
 * its own. The picker is an Electron one because these are filesystem paths
 * outside the vault, where the declarative file control's suggester is no help.
 */
function cliPathRow(
  ctx: SectionContext,
  path: CliPath,
): SettingDefinitionRender {
  return {
    name: path.name,
    desc: path.desc,
    render: (setting: Setting) => {
      let committed = ctx.plugin.settings[path.key] ?? ""

      setting.addText((input) => {
        const commit = async (value: string): Promise<void> => {
          if (value === committed) return
          await cliPathHandler(path).write(value, ctx)
          // The handler trims and may reject outright, so the field follows
          // what was actually stored rather than what was typed.
          committed = ctx.plugin.settings[path.key] ?? ""
          if (committed !== value) input.setValue(committed)
        }

        input
          .setPlaceholder(
            t("settings.aiTask.pathPlaceholder", "Auto-detect (recommended)"),
          )
          .setValue(committed)
        // Saving on every keystroke would fire the shim rejection midway
        // through typing "claude.cmd" and blank the field under the cursor, so
        // the value is committed on blur instead.
        input.inputEl.addEventListener("blur", () => {
          void commit(input.getValue())
        })
        input.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") input.inputEl.blur()
        })
      })

      setting.addExtraButton((button) =>
        button
          .setIcon("folder")
          .setTooltip(t("settings.aiTask.pathBrowse", "Browse"))
          .onClick(() => {
            void browseForCliPath(ctx, path)
          }),
      )
    },
  }
}


/**
 * Everything a Pro license unlocks. Only reached from the Pro page, which has
 * already checked entitlement.
 */
export function aiTaskSection(guard: AiTaskToggleGuard): SectionModule {
  const paths = cliPaths()

  return {
    items: (ctx) => [
      {
        type: "group",
        heading: t("settings.aiTask.heading", "AI task"),
        items: [
          {
            name: t("settings.aiTask.enable", "Enable AI tasks"),
            desc: t(
              "settings.aiTask.enableDesc",
              "Run tasks with the claude or codex CLI inside the AI run pane (desktop only).",
            ),
            control: {
              type: "toggle",
              key: "aiTaskEnabled",
              defaultValue: false,
            },
          },
          ...paths.map((path) => cliPathRow(ctx, path)),
          {
            name: t("settings.aiTask.retentionName", "Run log retention (days)"),
            desc: t(
              "settings.aiTask.retentionDesc",
              "Run log notes older than this many days are deleted automatically.",
            ),
            control: {
              type: "number",
              key: "aiTaskLogRetentionDays",
              defaultValue: DEFAULT_SETTINGS.aiTaskLogRetentionDays,
              min: 1,
              step: 1,
              placeholder: String(DEFAULT_SETTINGS.aiTaskLogRetentionDays),
            },
          },
        ],
      },
    ],

    handlers: {
      aiTaskEnabled: {
        read: (ctx) => ctx.plugin.settings.aiTaskEnabled ?? false,
        // Not one of the ordinary toggles: the service owns persisting, waiting
        // out any previous runtime, and dropping completions that a newer
        // toggle or a reloaded plugin has overtaken.
        write: (value, ctx) =>
          handleAiTaskEnabledToggle(ctx.plugin, guard, Boolean(value)),
      },
      aiTaskLogRetentionDays: clampedNumber({
        read: (settings) => settings.aiTaskLogRetentionDays,
        write: (settings, value) => {
          settings.aiTaskLogRetentionDays = value
        },
        min: 1,
        fallback: DEFAULT_SETTINGS.aiTaskLogRetentionDays ?? 30,
      }),
    },
  }
}
