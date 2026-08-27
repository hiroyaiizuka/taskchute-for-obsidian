import { Notice, setIcon } from "obsidian"
import type { SettingDefinitionItem } from "obsidian"
import { getCurrentLocale, t } from "../../../i18n"
import { licensePurchaseUrl } from "../../../features/license/config"
import type { LicenseManager } from "../../../features/license/services/LicenseManager"
import { formatLicenseId } from "../../../features/license/token/primitives"
import { DeviceListView } from "../../../features/license/ui/DeviceListView"
import {
  describeActivationFailure,
  describeApiFailure,
} from "../../../features/license/ui/licenseMessages"
import { showInfoModal } from "../../../ui/modals/ConfirmModal"
import type { AnyControlHandler, SectionContext } from "../../types"
import { LicenseActivationState } from "./licenseActivationState"

/** Draft only — an unactivated code is not a setting. */
export const LICENSE_CODE_KEY = "license.code"

export function licenseCodeHandler(
  form: LicenseActivationState,
): AnyControlHandler {
  return {
    read: (ctx) => form.currentCode(ctx.plugin.settings.licenseCode),
    write: (value) => {
      form.code = String(value)
    },
  }
}

/**
 * Where the code comes from is a one-time question, so it sits behind an info
 * icon rather than taking a permanent paragraph above the field.
 */
function helpRow(ctx: SectionContext): SettingDefinitionItem {
  return {
    name: t("settings.license.codeHelpLabel", "About the license code"),
    render: (setting) => {
      setIcon(setting.nameEl.createSpan(), "info")
      setting.settingEl.addEventListener("click", () => {
        void showInfoModal(ctx.app, {
          title: t("settings.license.codeHelpTitle", "About the license code"),
          message: t(
            "settings.license.codeHelpBody",
            "AI tasks require a TaskChute Plus Pro license.\nYour license code is in the email you received when you bought it. If you cannot find that email, check your spam folder.",
          ),
          confirmText: t("settings.license.codeHelpClose", "OK"),
        })
      })
    },
  }
}

/** Someone reading this screen without a code needs a way to buy one. */
function purchaseRow(): SettingDefinitionItem {
  // A fragment rather than a string: the row's description has to carry a real
  // link, and its text content still feeds the settings search.
  const desc = createFragment((fragment) => {
    fragment.appendText(
      t("settings.license.purchaseBefore", "You can buy an activation code "),
    )
    fragment.createEl("a", {
      text: t("settings.license.purchaseLink", "here"),
      attr: {
        href: licensePurchaseUrl(getCurrentLocale()),
        target: "_blank",
        rel: "noopener",
      },
    })
    fragment.appendText(t("settings.license.purchaseAfter", "."))
  })

  return {
    name: t("settings.license.purchaseName", "Buy a license"),
    desc,
  }
}

async function activate(
  ctx: SectionContext,
  manager: LicenseManager,
  form: LicenseActivationState,
  applyLicenseChange: () => Promise<void>,
): Promise<void> {
  form.beginActivation()
  ctx.update()

  const result = await manager.activate(
    form.currentCode(ctx.plugin.settings.licenseCode),
  )

  if (result.ok) {
    new Notice(t("settings.license.activated", "License activated."))
    form.reset()
    await applyLicenseChange()
    ctx.update()
    return
  }

  form.failActivation(describeActivationFailure(result.failure), result.failure)
  ctx.update()
}

/** The form for someone who has a code but has not used it yet. */
function activationRows(
  ctx: SectionContext,
  manager: LicenseManager,
  form: LicenseActivationState,
  applyLicenseChange: () => Promise<void>,
): SettingDefinitionItem[] {
  const state = manager.getState()
  const rows: SettingDefinitionItem[] = []

  if (state.status === "blocked") {
    rows.push({
      name: t("settings.license.statusName", "Status"),
      desc: describeApiFailure({
        ok: false,
        kind: "api",
        code: state.reason,
        status: 403,
      }),
    })
  }

  rows.push({
    name: t("settings.license.codeName", "License code"),
    control: {
      type: "text",
      key: LICENSE_CODE_KEY,
      defaultValue: "",
      placeholder: t(
        "settings.license.codePlaceholder",
        "TCP-XXXX-XXXX-XXXX-XXXX",
      ),
    },
  })

  rows.push(helpRow(ctx))

  rows.push({
    name: form.activating
      ? t("settings.license.activating", "Activating…")
      : t("settings.license.activate", "Activate"),
    desc: form.errorDesc,
    disabled: () => form.activating,
    action: () => {
      void activate(ctx, manager, form, applyLicenseChange)
    },
  })

  // The seat limit is the one failure the user can fix right here, and the 409
  // already carried the list, so no second request is needed.
  rows.push({
    name: t("settings.license.devicesName", "Devices"),
    visible: () => form.deviceLimitFailure !== null,
    render: (_setting, group) => {
      const failure = form.deviceLimitFailure
      if (!failure) return undefined
      const view = new DeviceListView(group.listEl, manager, {
        initialDevices: failure.devices,
        onChanged: () => {
          form.clearError()
          ctx.refreshDomState()
        },
      })
      return () => {
        view.dispose()
      }
    },
  })

  rows.push(purchaseRow())

  return rows
}

/** What an activated license looks like: the license itself, and its seats. */
function activeLicenseRows(
  ctx: SectionContext,
  manager: LicenseManager,
  applyLicenseChange: () => Promise<void>,
): SettingDefinitionItem[] {
  const summary = manager.getLicenseSummary()
  // No status or expiry rows: the page header already says "Active", and the
  // seats below are the only part of an active license anyone acts on.
  const rows: SettingDefinitionItem[] = []

  if (summary) {
    rows.push({
      name: t("settings.license.licenseIdName", "License ID"),
      desc: formatLicenseId(summary.license_id),
    })
  }

  rows.push({
    name: t("settings.license.devicesName", "Devices"),
    // Releasing this very device is done from the list like any other seat, so
    // there is no separate sign-out control.
    render: (_setting, group) => {
      const view = new DeviceListView(group.listEl, manager, {
        onChanged: () => {
          // Seat counts come from the server, so a release has to re-read the
          // summary; rebuilding is the cheapest way to stay consistent, and it
          // also covers the release that drops this device out of the license.
          void manager
            .refreshIfNeeded(true)
            .then(() => applyLicenseChange())
            .then(() => {
              ctx.update()
            })
        },
      })
      // Returned rather than tracked by hand: the framework tears the row down
      // before replacing it, so an in-flight request can never write into a
      // container that is already gone.
      return () => {
        view.dispose()
      }
    },
  })

  return rows
}

export function licenseRows(
  ctx: SectionContext,
  manager: LicenseManager,
  form: LicenseActivationState,
  applyLicenseChange: () => Promise<void>,
): SettingDefinitionItem[] {
  return manager.isActive()
    ? activeLicenseRows(ctx, manager, applyLicenseChange)
    : activationRows(ctx, manager, form, applyLicenseChange)
}
