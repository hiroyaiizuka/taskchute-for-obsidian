import { t } from "@/i18n"
import { toggle } from "@/settings/controlHandlers"
import { rerenderTaskLists } from "@/settings/services/viewNotifications"
import type { SectionModule } from "@/settings/types"

/** The button for the day's comments at the bottom right of the task list (#181, LEV-346). Off until turned on. */
export const dayCommentsSection: SectionModule = {
  items: () => [
    {
      name: t("settings.advanced.dayComments", "Comments for the day"),
      desc: t(
        "settings.advanced.dayCommentsDesc",
        "Show a button at the bottom right of the task list that opens the comments for the day.",
      ),
      control: {
        type: "toggle",
        key: "dayCommentsEnabled",
        defaultValue: false,
      },
    },
  ],

  handlers: {
    dayCommentsEnabled: toggle({
      read: (settings) => settings.dayCommentsEnabled,
      write: (settings, value) => {
        settings.dayCommentsEnabled = value
      },
      // Only whether the button is drawn changes, so a re-render is enough.
      after: (_value, ctx) => {
        rerenderTaskLists(ctx.app)
      },
    }),
  },
}
