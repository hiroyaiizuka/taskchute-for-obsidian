import { t } from "../../i18n"
import type { SectionModule } from "../types"

/** The installed version, straight from manifest.json. */
export function versionSection(): SectionModule {
  return {
    items: (ctx) => [
      {
        type: "group",
        cls: "taskchute-version-setting",
        items: [
          {
            name: t("settings.version.name", "Version"),
            desc: ctx.plugin.manifest.version,
          },
        ],
      },
    ],
  }
}
