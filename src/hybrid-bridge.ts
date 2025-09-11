/**
 * Hybrid Bridge Module
 * 既存のJavaScriptコードとTypeScriptモジュールを橋渡しするモジュール
 * 段階的移行のために使用
 */

import { PathManager } from './managers/PathManager';
import { RoutineAliasManager } from './managers/RoutineAliasManager';
import { TaskChuteView } from './views/TaskChuteView';
import { LogView } from './views/LogView';
import { TaskChuteSettingTab } from './ui/SettingsTab';
import { TaskNameAutocomplete } from './ui/TaskNameAutocomplete';
import { Logger } from './utils/logger';
import * as dateUtils from './utils/date';
import { DEFAULT_SETTINGS } from './settings';

// グローバルに公開（既存のmain.jsから参照可能にする）
(window as any).TaskChuteTSModules = {
  // Managers
  PathManager,
  RoutineAliasManager,
  
  // Views
  TaskChuteView,
  LogView,
  
  // UI
  TaskChuteSettingTab,
  TaskNameAutocomplete,
  
  // Utils
  Logger,
  dateUtils,
  
  // Settings
  DEFAULT_SETTINGS,
  
  // フラグ：TypeScriptモジュールが利用可能かどうか
  isAvailable: true,
  
  // バージョン情報
  version: '1.0.0-hybrid'
};


export {
  PathManager,
  RoutineAliasManager,
  TaskChuteView,
  LogView,
  TaskChuteSettingTab,
  TaskNameAutocomplete,
  Logger,
  dateUtils,
  DEFAULT_SETTINGS
};
