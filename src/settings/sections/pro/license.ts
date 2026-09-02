import { Notice, setIcon } from "obsidian"
import type {
  Setting,
  SettingDefinitionItem,
  SettingDefinitionRender,
} from "obsidian"
import { getCurrentLocale, t } from "../../../i18n"
import { licensePurchaseUrl } from "../../../features/license/config"
import type { LicenseManager } from "../../../features/license/services/LicenseManager"
import { formatLicenseId } from "../../../features/license/token/primitives"
import { DeviceListView } from "../../../features/license/ui/DeviceListView"
import { checkSeatRegistration } from "../../../features/license/ui/notifySeatReleased"
import {
  describeActivationFailure,
  describeApiFailure,
} from "../../../features/license/ui/licenseMessages"
import { showConfirmModal, showInfoModal } from "../../../ui/modals/ConfirmModal"
import type { SectionContext } from "../../types"
import { LicenseActivationState } from "./licenseActivationState"

/**
 * Where the device list mounts.
 *
 * The row's own control element, not the group the render callback is handed:
 * the framework finishes a group by setting its list to exactly the rows'
 * elements, so anything else put there is removed in the same pass — which is
 * how the list came to render into nothing at all. `Setting.clear()` empties
 * the control element before a row is rendered again, so mounting here also
 * keeps a re-render from stacking two lists.
 *
 * The row lays its name and control out side by side, so it takes a class that
 * turns it into a column and lets the list have the full width.
 */
function deviceListHost(setting: Setting): HTMLElement {
  setting.settingEl.addClass("taskchute-license-devices-item")
  return setting.controlEl
}

/**
 * Re-ask the server whether this device is licensed, because the Pro page is
 * being shown.
 *
 * A row's render callback is the seam for that: the page's `items` are built
 * with the rest of the tab's definitions, long before anyone navigates into it,
 * and only these callbacks run at the moment it is drawn. Both shapes of the
 * page call it, since "is my license working again?" matters most to someone
 * looking at the activation form.
 *
 * Not forced: arriving at the settings tab has already forced one, and a forced
 * sync here would re-run on every redraw of the page — including the redraw a
 * changed answer causes. Throttled, the page reuses an answer at most a minute
 * old and a redraw settles.
 */
function syncOnShown(ctx: SectionContext): void {
  void checkSeatRegistration(ctx.plugin).then((result) => {
    if (result.changed) ctx.update()
  })
}

/**
 * Where the code comes from is a one-time question, so it sits behind an info
 * icon on the label rather than taking a row or a standing paragraph.
 */
function helpButton(ctx: SectionContext, setting: Setting): void {
  const button = setting.nameEl.createEl("button", {
    cls: "clickable-icon taskchute-license-code__help",
    attr: {
      type: "button",
      "aria-label": t(
        "settings.license.codeHelpLabel",
        "About the license code",
      ),
    },
  })
  setIcon(button, "info")

  button.addEventListener("click", () => {
    void showInfoModal(ctx.app, {
      title: t("settings.license.codeHelpTitle", "About the license code"),
      message: t(
        "settings.license.codeHelpBody",
        "AI tasks require a TaskChute Plus Pro license.\nYour license code is in the email you received when you bought it. If you cannot find that email, check your spam folder.",
      ),
      confirmText: t("settings.license.codeHelpClose", "OK"),
    })
  })
}

/**
 * The whole form in one row: the code, the button that spends it, and the note
 * about where the code comes from.
 *
 * Built imperatively rather than from a `control` definition because the three
 * belong to a single action — a declarative control owns the row's control
 * area alone, which would push the button onto a row of its own and leave the
 * field too narrow for a code of this length.
 */
function codeRow(
  ctx: SectionContext,
  manager: LicenseManager,
  form: LicenseActivationState,
  applyLicenseChange: () => Promise<void>,
): SettingDefinitionItem {
  return {
    name: t("settings.license.codeName", "License code"),
    // A failure belongs under the field it was typed into.
    desc: form.errorDesc,
    render: (setting) => {
      // The activation form is drawn only on the Pro page, so this row being
      // rendered is that page being shown.
      syncOnShown(ctx)
      setting.settingEl.addClass("taskchute-license-code-item")
      // A failure is not a description: it reads as one unless it is coloured
      // like the error it is.
      setting.settingEl.classList.toggle(
        "taskchute-license-code-item--error",
        form.errorDesc.length > 0,
      )
      helpButton(ctx, setting)

      setting.addText((text) => {
        text
          .setPlaceholder(
            t("settings.license.codePlaceholder", "TCP-XXXX-XXXX-XXXX-XXXX"),
          )
          // Re-seeded on every render: the row is rebuilt whenever activation
          // starts or fails, and the draft must survive that.
          .setValue(form.currentCode(manager.getStoredCode()))
          .onChange((value) => {
            form.code = value
          })
      })

      setting.addButton((button) => {
        button
          .setCta()
          .setButtonText(
            form.activating
              ? t("settings.license.activating", "Activating…")
              : t("settings.license.activate", "Activate"),
          )
          .setDisabled(form.activating)
          .onClick(() => {
            void activate(ctx, manager, form, applyLicenseChange)
          })
      })
    },
  }
}

/** Someone reading this screen without a code needs a way to buy one. */
function purchaseRow(): SettingDefinitionItem {
  return {
    name: t("settings.license.purchaseName", "Buy a license"),
    // The row itself opens the page — there is nothing else to do with it, and
    // an inline link inside a description is a smaller target than the row.
    action: (el) => {
      const opened = el.ownerDocument.defaultView?.open(
        licensePurchaseUrl(getCurrentLocale()),
        "_blank",
        "noopener,noreferrer",
      )
      if (opened) opened.opener = null
    },
  }
}

/**
 * The way out of a licence this vault cannot act with.
 *
 * The token is device-local and the code lives in the synced vault settings, so
 * a vault can be licensed while holding no code — activated from another vault
 * on this machine, or a data.json that never carried it. Everything that talks
 * to the server then fails on the code that is not there, and the active screen
 * offers no field to supply one. Signing out drops the token, which brings the
 * activation form back, and that form is the field.
 *
 * Only ever shown in that state: with a code in hand, the seat list already
 * releases this device properly, and that path tells the server.
 */
function signOutRow(
  ctx: SectionContext,
  manager: LicenseManager,
  applyLicenseChange: () => Promise<void>,
): SettingDefinitionRender {
  return {
    name: t("settings.license.signOutName", "Sign out on this device"),
    desc: t(
      "settings.license.signOutDesc",
      "This vault has no license code stored, so devices cannot be managed from here. Sign out to enter your code again. The seat stays with this device, so re-entering the same code costs no extra device.",
    ),
    render: (setting) => {
      setting.addButton((button) => {
        button
          .setDestructive()
          .setButtonText(t("settings.license.signOut", "Sign out"))
          .onClick(() => {
            void signOut(ctx, manager, applyLicenseChange)
          })
      })
    },
  }
}

async function signOut(
  ctx: SectionContext,
  manager: LicenseManager,
  applyLicenseChange: () => Promise<void>,
): Promise<void> {
  const confirmed = await showConfirmModal(ctx.app, {
    title: t("settings.license.signOutConfirmTitle", "Sign out on this device?"),
    message: t(
      "settings.license.signOutConfirmBody",
      "AI tasks stop working on this device until you enter your license code again.",
    ),
    confirmText: t("settings.license.signOut", "Sign out"),
    destructive: true,
  })
  if (!confirmed) return

  manager.signOutLocally()
  await applyLicenseChange()
  ctx.update()
  new Notice(t("settings.license.signedOut", "Signed out on this device."))
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
    form.currentCode(manager.getStoredCode()),
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

  rows.push(codeRow(ctx, manager, form, applyLicenseChange))

  // The seat limit is the one failure the user can fix right here, and the 409
  // already carried the list, so no second request is needed.
  rows.push({
    type: "group",
    heading: t("settings.license.devicesName", "Devices"),
    visible: () => form.deviceLimitFailure !== null,
    items: [
      {
        // Nameless, like the seats section of an active license: the heading
        // names it and the list takes the whole row.
        name: "",
        render: (setting) => {
          const failure = form.deviceLimitFailure
          if (!failure) return undefined
          const view = new DeviceListView(deviceListHost(setting), manager, {
            initialDevices: failure.devices,
            // The rejected activation stored nothing, so the list has to carry
            // the typed code or releasing a seat would have none to send.
            code: form.currentCode(manager.getStoredCode()),
            onChanged: () => {
              form.clearError()
              ctx.refreshDomState()
            },
          })
          return () => {
            view.dispose()
          }
        },
      },
    ],
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
  // Two sections rather than a single card: the licence is a fact to read once,
  // the seats are a list to act on, and a heading over each says which is which.
  // No status or expiry rows — the page header already says "Active".
  const rows: SettingDefinitionItem[] = []

  // The code the user actually typed, not the id derived from it: that is what
  // they hold, what support asks for, and what they would re-enter elsewhere.
  // The id is the fallback for a licence activated before the code was stored.
  // Read through the manager so a device that gave up its seat does not show a
  // code it can no longer use.
  const stored = manager.getStoredCode()
  const identity =
    stored !== undefined && stored.length > 0
      ? { name: t("settings.license.codeName", "License code"), value: stored }
      : summary
        ? {
            name: t("settings.license.licenseIdName", "License ID"),
            value: formatLicenseId(summary.license_id),
          }
        : undefined

  // No code here means no request can be made: the seat list, its refresh and
  // every release need one. The list would show nothing but a permanent
  // no_activation_code, so it is replaced by the one action that does work.
  const codeless = stored === undefined || stored.length === 0

  if (identity) {
    rows.push({
      type: "group",
      heading: t("settings.license.heading", "License"),
      cls: "taskchute-license-identity",
      items: [
        { name: identity.name, desc: identity.value },
        ...(codeless ? [signOutRow(ctx, manager, applyLicenseChange)] : []),
      ],
    })
  }

  if (codeless) return rows

  rows.push({
    type: "group",
    heading: t("settings.license.devicesName", "Devices"),
    items: [{
    // No name: the heading above already names the section, so the list takes
    // the whole row. Releasing this very device is done from the list like any
    // other seat, so there is no separate sign-out control.
    name: "",
    render: (setting) => {
      // Same seam as the activation form: the seat list is only ever drawn on
      // the Pro page, so mounting it is that page being shown.
      syncOnShown(ctx)
      const view = new DeviceListView(deviceListHost(setting), manager, {
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
    }],
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
