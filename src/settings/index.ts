// The defaults live in their own module so section definitions can read them
// without importing this barrel, which also re-exports the settings tab.
export { DEFAULT_SETTINGS } from './defaults';
export { TaskChuteSettingTab } from './SettingsTab';
