import { Notice } from "obsidian"
import { t } from "../../i18n"
import {
  ProUnlockState,
  isProSectionVisible,
} from "../proUnlockState"
import type { SectionModule } from "../types"

/**
 * The installed version, straight from manifest.json — and the hidden unlock
 * for the Pro section, which counts clicks on this row.
 */
export function versionSection(unlock: ProUnlockState): SectionModule {
  return {
    items: (ctx) => [
      {
        type: "group",
        cls: "taskchute-version-setting",
        items: [
          {
            name: t("settings.version.name", "Version"),
            desc: ctx.plugin.manifest.version,
            action: () => {
              if (isProSectionVisible(ctx, unlock)) return
              if (!unlock.registerClick()) return
              new Notice(
                t(
                  "settings.version.proUnlocked",
                  "Pro settings are now visible.",
                ),
              )
              // Only the Pro page's visibility predicate flipped; the
              // definition tree is unchanged.
              ctx.refreshDomState()
            },
          },
        ],
      },
    ],
  }
}
