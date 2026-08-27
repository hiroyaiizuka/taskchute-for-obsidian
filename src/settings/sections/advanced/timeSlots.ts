import { t } from "../../../i18n"
import { toggle } from "../../controlHandlers"
import { rerenderTaskLists } from "../../services/viewNotifications"
import type { SectionModule } from "../../types"

export const timeSlotsSection: SectionModule = {
  items: () => [
    {
      name: t("settings.advanced.collapsibleTimeSlots", "Collapsible time slots"),
      desc: t(
        "settings.advanced.collapsibleTimeSlotsDesc",
        "Click time slot headers to collapse/expand sections",
      ),
      control: {
        type: "toggle",
        key: "collapsibleTimeSlots",
        defaultValue: false,
      },
    },
  ],

  handlers: {
    collapsibleTimeSlots: toggle({
      read: (settings) => settings.collapsibleTimeSlots,
      write: (settings, value) => {
        settings.collapsibleTimeSlots = value
      },
      // Purely a matter of how the list draws, so a re-render is enough.
      after: (_value, ctx) => {
        rerenderTaskLists(ctx.app)
      },
    }),
  },
}
