import { Notice, Platform } from "obsidian"
import type { Setting, SettingDefinitionRender } from "obsidian"
import { t } from "../../../i18n"
import { ElectronDirectoryPicker } from "../../../features/ai-task/services/ElectronDirectoryPicker"
import type { TaskChuteSettings } from "../../../types"
import { DEFAULT_SETTINGS } from "../../defaults"
import { clampedNumber, choice } from "../../controlHandlers"
import {
  AiTaskToggleGuard,
  handleAiTaskEnabledToggle,
} from "../../services/aiTaskLifecycle"
import type {
  AnyControlHandler,
  SectionContext,
  SectionModule,
} from "../../types"

type AiTaskRunMode = NonNullable<TaskChuteSettings["aiTaskRunMode"]>

/**
 * On Windows these launch through a shim that swallows the child process, so a
 * run started from one can never be stopped. Rejected outright rather than
 * failing later at launch.
 */
function isUnsupportedWindowsCliShim(path: string): boolean {
  return /\.(?:bat|cmd|ps1)$/iu.test(path)
}

interface CliPath {
  key: "aiTaskClaudePath" | "aiTaskCodexPath"
  name: string
  desc: string
}

function cliPaths(): CliPath[] {
  return [
    {
      key: "aiTaskClaudePath",
      name: t(
        "settings.aiTask.claudePathName",
        "Claude CLI path (advanced fallback)",
      ),
      desc: t(
        "settings.aiTask.claudePathDesc",
        "Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.",
      ),
    },
    {
      key: "aiTaskCodexPath",
      name: t(
        "settings.aiTask.codexPathName",
        "Codex CLI path (advanced fallback)",
      ),
      desc: t(
        "settings.aiTask.codexPathDesc",
        "Normally leave this empty: macOS, Linux, and Windows are auto-detected. Set a custom path only when detection fails. On Windows, do not select a command shim.",
      ),
    },
  ]
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
 *
 * Rendered on desktop only. Every row here configures a local CLI the plugin
 * spawns -- which `evaluateAiTaskAvailability` already refuses on mobile as
 * `not-desktop` -- so a licensed iPad would otherwise be offered a feature it
 * can never run. The license rows stay: those matter on every platform.
 */
export function aiTaskSection(guard: AiTaskToggleGuard): SectionModule {
  const paths = cliPaths()

  return {
    items: (ctx) => (!Platform.isDesktop ? [] : [
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
          {
            name: t("settings.aiTask.runModeName", "Run mode"),
            desc: t(
              "settings.aiTask.runModeDesc",
              "Terminal embeds the interactive CLI session on macOS and Linux; conversation mode streams parsed events and supports follow-up input on every desktop platform. Windows automatically uses it because the plugin does not bundle a native pseudoterminal runtime.",
            ),
            control: {
              type: "dropdown",
              key: "aiTaskRunMode",
              defaultValue: "terminal",
              options: {
                terminal: t(
                  "settings.aiTask.runModeTerminal",
                  "Terminal (interactive)",
                ),
                headless: t(
                  "settings.aiTask.runModeHeadless",
                  "Conversation (cross-platform)",
                ),
              },
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
    ]),

    handlers: {
      aiTaskEnabled: {
        read: (ctx) => ctx.plugin.settings.aiTaskEnabled ?? false,
        // Not one of the ordinary toggles: the service owns persisting, waiting
        // out any previous runtime, and dropping completions that a newer
        // toggle or a reloaded plugin has overtaken.
        write: (value, ctx) =>
          handleAiTaskEnabledToggle(ctx.plugin, guard, Boolean(value)),
      },
      aiTaskRunMode: choice<AiTaskRunMode>({
        read: (settings) => settings.aiTaskRunMode,
        write: (settings, value) => {
          settings.aiTaskRunMode = value
        },
        normalize: (raw) => (raw === "headless" ? "headless" : "terminal"),
      }),
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
