import { TaskChuteSettings } from '../types';

export const DEFAULT_SETTINGS: TaskChuteSettings = {
  // New storage model defaults
  locationMode: 'vaultRoot',
  specifiedFolder: undefined,
  projectsFolder: null, // unset by default
  projectTitlePrefix: 'Project - ',
  projectTemplatePath: null,

  useOrderBasedSort: true,
  slotKeys: {},
  languageOverride: 'auto',
  aiRobotButtonEnabled: false,
  reviewTemplatePath: null,
  reviewFileNamePattern: 'Review - {{date}}.md',
  backupIntervalHours: 2,
  backupRetentionDays: 1,

  // Reminder defaults
  defaultReminderMinutes: 5,

  // Google Calendar export (URL scheme push-only)
  googleCalendar: {
    enabled: false,
    defaultDurationMinutes: 60,
    includeNoteContent: true,
  },
};

export { TaskChuteSettingTab } from './SettingsTab';
