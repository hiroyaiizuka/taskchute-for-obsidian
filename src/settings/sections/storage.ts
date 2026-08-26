import { t } from "../../i18n"
import type { LocationMode } from "../../types"
import { choice, validateVaultPath, vaultPath } from "../controlHandlers"
import type { SectionContext, SectionModule } from "../types"

function currentMode(ctx: SectionContext): LocationMode {
  return ctx.plugin.settings.locationMode ?? "vaultRoot"
}

/** Where TaskChute keeps its task, log and review files. */
export const storageSection: SectionModule = {
  items: (ctx) => [
    {
      type: "group",
      heading: t("settings.heading", "TaskChute file paths"),
      items: [
        {
          name: t(
            "settings.storage.baseLocationName",
            "Default storage location",
          ),
          desc: t(
            "settings.storage.baseLocationDesc",
            "Save task/log/review under the selected base.",
          ),
          control: {
            type: "dropdown",
            key: "locationMode",
            defaultValue: "vaultRoot",
            options: {
              vaultRoot: t(
                "settings.storage.baseOptions.vaultRoot",
                "Vault root (TaskChute/...)",
              ),
              specifiedFolder: t(
                "settings.storage.baseOptions.specifiedFolder",
                "Below specified folder",
              ),
            },
          },
        },
        {
          name: t("settings.storage.specifiedFolderName", "Specified folder"),
          desc: t(
            "settings.storage.specifiedFolderDesc",
            "TaskChute/... will be created under this folder.",
          ),
          // Only meaningful under the matching mode; the row stays in the tree
          // so switching modes is a predicate flip rather than a rebuild.
          visible: () => currentMode(ctx) === "specifiedFolder",
          control: {
            type: "folder",
            key: "specifiedFolder",
            defaultValue: "",
            validate: (value) => validateVaultPath(ctx, value),
          },
        },
      ],
    },
  ],

  handlers: {
    locationMode: choice<LocationMode>({
      read: (settings) => settings.locationMode ?? "vaultRoot",
      write: (settings, value) => {
        settings.locationMode = value
      },
      normalize: (raw) =>
        raw === "specifiedFolder" ? "specifiedFolder" : "vaultRoot",
      after: (_value, ctx) => {
        ctx.refreshDomState()
      },
    }),
    specifiedFolder: vaultPath({
      read: (settings) => settings.specifiedFolder,
      write: (settings, value) => {
        settings.specifiedFolder = value
      },
      empty: undefined,
      kind: "folder",
      missingNotice: (path) =>
        t("settings.validation.missingFolder", "Folder was not found: {path}", {
          path,
        }),
    }),
  },
}
