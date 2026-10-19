import buildInfo from "taskchute:build-info"
import { t } from "@/i18n"
import type { SectionModule } from "../types"

type BuildInfo = typeof buildInfo

/**
 * "2.2.16 (614)": the version from manifest.json and the build number, so a
 * copy installed through BRAT or synced from a dev build can be told apart from
 * the latest one. Without a build number (built without git) only the version.
 */
export function formatVersion(version: string, info: BuildInfo): string {
  return info.number > 0 ? `${version} (${info.number})` : version
}

/** The installed version and the build it came from. */
export function versionSection(info: BuildInfo = buildInfo): SectionModule {
  return {
    items: (ctx) => [
      {
        type: "group",
        cls: "taskchute-version-setting",
        items: [
          {
            name: t("settings.version.name", "Version"),
            desc: formatVersion(ctx.plugin.manifest.version, info),
          },
        ],
      },
    ],
  }
}
