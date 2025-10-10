import { TaskChuteSettings } from '../types';

export const DEFAULT_SETTINGS: TaskChuteSettings = {
  // New storage model defaults
  locationMode: 'vaultRoot',
  specifiedFolder: undefined,
  projectsFolder: null, // unset by default
  projectsFilterEnabled: false,
  projectsFilter: {
    prefixes: [],
    tags: [],
    includeSubfolders: true,
    matchMode: 'OR',
    trimPrefixesInUI: true,
    transformName: false,
    limit: 50,
    nameRegex: undefined,
    excludePathRegex: undefined,
  },

  useOrderBasedSort: true,
  slotKeys: {},
  languageOverride: 'auto',
  aiRobotButtonEnabled: false,
};

export { TaskChuteSettingTab } from './SettingsTab';
