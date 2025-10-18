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
};

export { TaskChuteSettingTab } from './SettingsTab';
