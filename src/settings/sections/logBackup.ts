import { t } from "../../i18n"
import { DEFAULT_SETTINGS } from "../defaults"
import { clampedNumber } from "../controlHandlers"
import type { SectionModule } from "../types"

/** How often JSON backups are taken and how long they are kept. */
export const logBackupSection: SectionModule = {
  items: () => [
    {
      type: "group",
      heading: t("settings.logBackup.heading", "Log"),
      items: [
        {
          name: t(
            "settings.logBackup.intervalName",
            "Backup interval (hours)",
          ),
          desc: t(
            "settings.logBackup.intervalDesc",
            "Only create JSON backups if the previous backup is older than this many hours.",
          ),
          control: {
            type: "number",
            key: "backupIntervalHours",
            defaultValue: DEFAULT_SETTINGS.backupIntervalHours,
            min: 1,
            step: 1,
            placeholder: String(DEFAULT_SETTINGS.backupIntervalHours),
          },
        },
        {
          name: t(
            "settings.logBackup.retentionName",
            "Backup retention (days)",
          ),
          desc: t(
            "settings.logBackup.retentionDesc",
            "Backups older than this window are deleted automatically during reconciliation.",
          ),
          control: {
            type: "number",
            key: "backupRetentionDays",
            defaultValue: DEFAULT_SETTINGS.backupRetentionDays,
            min: 1,
            step: 1,
            placeholder: String(DEFAULT_SETTINGS.backupRetentionDays),
          },
        },
      ],
    },
  ],

  handlers: {
    backupIntervalHours: clampedNumber({
      read: (settings) => settings.backupIntervalHours,
      write: (settings, value) => {
        settings.backupIntervalHours = value
      },
      min: 1,
      fallback: DEFAULT_SETTINGS.backupIntervalHours ?? 2,
    }),
    backupRetentionDays: clampedNumber({
      read: (settings) => settings.backupRetentionDays,
      write: (settings, value) => {
        settings.backupRetentionDays = value
      },
      min: 1,
      fallback: DEFAULT_SETTINGS.backupRetentionDays ?? 1,
    }),
  },
}
