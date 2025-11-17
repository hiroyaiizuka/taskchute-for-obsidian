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
  reviewFileNamePattern: 'Daily - {{date}}.md',
  backupIntervalHours: 24,
  backupRetentionDays: 30,
};

export { TaskChuteSettingTab } from './SettingsTab';
