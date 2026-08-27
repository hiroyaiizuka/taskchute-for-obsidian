import type { SettingDefinitionItem } from "obsidian"
import { t } from "../../../i18n"
import { syncAiTaskManagerToLicense } from "../../../features/ai-task/licenseGate"
import {
  ProUnlockState,
  isProLicenseActive,
  isProSectionVisible,
} from "../../proUnlockState"
import type { AiTaskToggleGuard } from "../../services/aiTaskLifecycle"
import { notifyAiTaskSettingsChanged } from "../../services/viewNotifications"
import type { SectionContext, SectionModule } from "../../types"
import { aiTaskSection } from "./aiTask"
import { LICENSE_CODE_KEY, licenseCodeHandler, licenseRows } from "./license"
import { LicenseActivationState } from "./licenseActivationState"

/** Create or dispose the AI runtime to match the new license state. */
async function applyLicenseChange(ctx: SectionContext): Promise<void> {
  try {
    await syncAiTaskManagerToLicense(ctx.plugin)
  } catch (error) {
    ctx.plugin._log?.("warn", "[License] Failed to apply license change", error)
  }
  notifyAiTaskSettingsChanged(ctx.app)
}

/**
 * Pro settings: everything the license unlocks, plus the license itself.
 *
 * Two shapes, chosen by entitlement. Activated, it shows the license, the
 * device seats and the AI task settings. Otherwise it shows only the activation
 * form — rendered rather than hidden, because someone who just bought the
 * plugin needs somewhere to enter their code.
 *
 * A page rather than the collapsed `details` block it used to be: the license
 * is set once and then left alone, so it stays out of the way of the daily
 * settings while remaining reachable from search.
 */
export function proSection(
  unlock: ProUnlockState,
  form: LicenseActivationState,
  guard: AiTaskToggleGuard,
): SectionModule {
  const aiTask = aiTaskSection(guard)

  return {
    items: (ctx) => {
      const manager = ctx.plugin.licenseManager
      let items: SettingDefinitionItem[]

      if (!manager) {
        // The manager is created during bootstrap; its absence means that
        // failed, and nothing here can work without it.
        items = [
          {
            name: t("settings.license.statusName", "Status"),
            desc: t(
              "license.errors.internal",
              "The license service returned an unexpected error. Try again later.",
            ),
          },
        ]
      } else {
        const active = isProLicenseActive(ctx)
        items = [
          ...licenseRows(ctx, manager, form, () => applyLicenseChange(ctx)),
          ...(active ? aiTask.items(ctx) : []),
        ]
      }

      return [
        {
          type: "page",
          name: t("settings.pro.heading", "Pro settings"),
          visible: () => isProSectionVisible(ctx, unlock),
          displayValue: () =>
            isProLicenseActive(ctx)
              ? t("settings.license.statusActive", "Active")
              : t("settings.license.statusInactive", "Not activated"),
          items,
        },
      ]
    },

    handlers: {
      ...aiTask.handlers,
      [LICENSE_CODE_KEY]: licenseCodeHandler(form),
    },
  }
}
