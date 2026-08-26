import { t } from "../../../i18n"
import { DEFAULT_SETTINGS } from "../../defaults"
import { clampedNumber, toggle } from "../../controlHandlers"
import type { SectionModule } from "../../types"

/** The key is dotted because the setting itself is nested. */
const GOOGLE_CALENDAR_KEY = "googleCalendar.enabled"

export const taskCreationSection: SectionModule = {
  items: () => [
    {
      type: "group",
      heading: t("settings.taskCreation.heading", "Task creation"),
      items: [
        {
          name: t(
            "settings.taskCreation.showAdvancedName",
            "Show advanced settings in the task creation modal",
          ),
          desc: t(
            "settings.taskCreation.showAdvancedDesc",
            "Adds start time, reminder, and calendar options to the new task modal.",
          ),
          control: {
            type: "toggle",
            key: "showTaskCreationAdvancedSettings",
            defaultValue: false,
          },
        },
        {
          name: t(
            "settings.reminder.defaultMinutesName",
            "Default reminder time (minutes)",
          ),
          desc: t(
            "settings.reminder.defaultMinutesDesc",
            "Default value when setting a new reminder.",
          ),
          control: {
            type: "number",
            key: "defaultReminderMinutes",
            defaultValue: DEFAULT_SETTINGS.defaultReminderMinutes,
            min: 0,
            step: 1,
            placeholder: String(DEFAULT_SETTINGS.defaultReminderMinutes),
          },
        },
        {
          name: t(
            "settings.googleCalendar.enable",
            "Enable Google Calendar registration",
          ),
          desc: t(
            "settings.googleCalendar.enableDesc",
            "Show “register to Google Calendar” in the task menu and open the browser with task details prefilled.",
          ),
          control: {
            type: "toggle",
            key: GOOGLE_CALENDAR_KEY,
            defaultValue: false,
          },
        },
      ],
    },
  ],

  handlers: {
    showTaskCreationAdvancedSettings: toggle({
      read: (settings) => settings.showTaskCreationAdvancedSettings,
      write: (settings, value) => {
        settings.showTaskCreationAdvancedSettings = value
      },
    }),
    defaultReminderMinutes: clampedNumber({
      read: (settings) => settings.defaultReminderMinutes,
      write: (settings, value) => {
        settings.defaultReminderMinutes = value
      },
      min: 0,
      fallback: DEFAULT_SETTINGS.defaultReminderMinutes ?? 5,
    }),
    [GOOGLE_CALENDAR_KEY]: toggle({
      read: (settings) => settings.googleCalendar?.enabled,
      write: (settings, value) => {
        // The export builds the event body from the note, so turning the
        // feature on turns note content on with it.
        settings.googleCalendar = {
          ...settings.googleCalendar,
          enabled: value,
          includeNoteContent: true,
        }
      },
    }),
  },
}
