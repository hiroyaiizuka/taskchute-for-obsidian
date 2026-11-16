import { t } from "@/i18n"
import { toggle } from "@/settings/controlHandlers"
import { rerenderTaskLists } from "@/settings/services/viewNotifications"
import type { SectionModule } from "@/settings/types"

/**
 * Comments: the button for the day's comments at the bottom right of the task
 * list (#181, LEV-346), and a task's comments from while it ran under its row
 * (LEV-412). Both off until turned on.
 */
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
    {
      name: t("settings.advanced.rowComments", "Show comments from while running in the task list"),
      desc: t(
        "settings.advanced.rowCommentsDesc",
        "List the comments left on a task while it ran under its name, with their times.",
      ),
      control: {
        type: "toggle",
        key: "rowCommentsEnabled",
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
    // LEV-412: the lists under the rows are drawn with the task list.
    rowCommentsEnabled: toggle({
      read: (settings) => settings.rowCommentsEnabled,
      write: (settings, value) => {
        settings.rowCommentsEnabled = value
      },
      after: (_value, ctx) => {
        rerenderTaskLists(ctx.app)
      },
    }),
  },
}
