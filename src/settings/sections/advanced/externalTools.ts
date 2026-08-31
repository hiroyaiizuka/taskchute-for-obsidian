import { Platform } from "obsidian"
import { t } from "../../../i18n"
import { TERMINAL_NAME } from "../../../constants"
import { toggle } from "../../controlHandlers"
import type { SectionModule } from "../../types"

export const externalToolsSection: SectionModule = {
  /**
   * Desktop only, group heading included: the toggle governs a button that
   * runs a Terminal plugin command, and that plugin is desktop-only, so on
   * mobile the row could only ever turn on a button that reports the plugin
   * as missing. The single row is the whole group, hence the empty list.
   */
  items: () =>
    Platform.isDesktop
      ? [
          {
            type: "group",
            heading: t("settings.features.heading", "External tools"),
            items: [
              {
                name: t("settings.features.robotButton", "Show terminal button"),
                desc: t(
                  "settings.features.robotButtonDesc",
                  `Enable AI integration via ${TERMINAL_NAME} (requires ${TERMINAL_NAME} plugin).`,
                ),
                control: {
                  type: "toggle",
                  key: "aiRobotButtonEnabled",
                  defaultValue: false,
                },
              },
            ],
          },
        ]
      : [],

  handlers: {
    aiRobotButtonEnabled: toggle({
      read: (settings) => settings.aiRobotButtonEnabled,
      write: (settings, value) => {
        settings.aiRobotButtonEnabled = value
      },
    }),
  },
}
