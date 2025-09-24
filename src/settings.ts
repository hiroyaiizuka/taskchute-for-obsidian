import { TaskChuteSettings } from './types';
import { PathManager } from './managers/PathManager';

export const DEFAULT_SETTINGS: TaskChuteSettings = {
  taskFolderPath: PathManager.DEFAULT_PATHS.taskFolder,
  projectFolderPath: PathManager.DEFAULT_PATHS.projectFolder,
  logDataPath: PathManager.DEFAULT_PATHS.logData,
  reviewDataPath: PathManager.DEFAULT_PATHS.reviewData,
  enableSound: false,
  enableFireworks: false,
  enableConfetti: false,
  useOrderBasedSort: true,
  slotKeys: {},
};
