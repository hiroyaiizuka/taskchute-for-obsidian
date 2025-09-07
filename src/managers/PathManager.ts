import { Plugin, normalizePath } from 'obsidian';
import { TaskChuteSettings } from '../types';

export class PathManager {
  private plugin: Plugin & { settings: TaskChuteSettings };

  constructor(plugin: Plugin & { settings: TaskChuteSettings }) {
    this.plugin = plugin;
  }

  static DEFAULT_PATHS = {
    taskFolder: "TaskChute/Task",
    projectFolder: "TaskChute/Project",
    logData: "TaskChute/Log",
    reviewData: "TaskChute/Review",
  };

  getTaskFolderPath(): string {
    const path =
      this.plugin.settings.taskFolderPath ||
      PathManager.DEFAULT_PATHS.taskFolder;
    return normalizePath(path);
  }

  getProjectFolderPath(): string {
    const path =
      this.plugin.settings.projectFolderPath ||
      PathManager.DEFAULT_PATHS.projectFolder;
    return normalizePath(path);
  }

  getLogDataPath(): string {
    const path =
      this.plugin.settings.logDataPath || PathManager.DEFAULT_PATHS.logData;
    return normalizePath(path);
  }

  getReviewDataPath(): string {
    const path =
      this.plugin.settings.reviewDataPath ||
      PathManager.DEFAULT_PATHS.reviewData;
    return normalizePath(path);
  }

  getLogYearPath(year: number | string): string {
    const logPath = this.getLogDataPath();
    return normalizePath(`${logPath}/${year}`);
  }

  async ensureYearFolder(year: number | string): Promise<string> {
    const yearPath = this.getLogYearPath(year);
    await this.ensureFolderExists(yearPath);
    return yearPath;
  }

  validatePath(path: string): { valid: boolean; error?: string } {
    if (path.startsWith("/") || path.match(/^[A-Za-z]:\\/)) {
      return { valid: false, error: "絶対パスは使用できません" };
    }
    if (path.includes("..")) {
      return { valid: false, error: "パスに'..'を含めることはできません" };
    }
    if (path.match(/[<>"|?*]/)) {
      return { valid: false, error: "パスに特殊文字を含めることはできません" };
    }
    return { valid: true };
  }

  async ensureFolderExists(path: string): Promise<void> {
    const folder = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!folder) {
      try {
        await this.plugin.app.vault.createFolder(path);
      } catch (error: any) {
        if (error.message && error.message.includes("Folder already exists")) {
          return;
        }
        throw error;
      }
    }
  }
}