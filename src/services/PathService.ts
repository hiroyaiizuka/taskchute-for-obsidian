import { Plugin, normalizePath } from 'obsidian';
import { TaskChuteSettings } from '../types';
import { t } from '../i18n';

export class PathService {
  private plugin: Plugin & { settings: TaskChuteSettings };

  constructor(plugin: Plugin & { settings: TaskChuteSettings }) {
    this.plugin = plugin;
  }

  // Back-compat: retained for legacy uses; not directly read from settings anymore
  static DEFAULT_PATHS = {
    taskFolder: 'TaskChute/Task',
    projectFolder: 'TaskChute/Project',
    logData: 'TaskChute/Log',
    reviewData: 'TaskChute/Review',
  };

  static GROUP = 'TaskChute' as const;
  static SUBDIR = { task: 'Task', log: 'Log', review: 'Review' } as const;

  private resolveBase(): string {
    const mode = this.plugin.settings.locationMode ?? 'vaultRoot';
    if (mode === 'specifiedFolder') {
      const specified = (this.plugin.settings.specifiedFolder || '').trim();
      if (!specified) return '';
      return normalizePath(specified);
    }
    return '';
  }

  private join(...parts: string[]): string {
    const filtered = parts.filter((p) => !!p && p.trim().length > 0);
    return normalizePath(filtered.join('/'));
  }

  getTaskFolderPath(): string {
    // New model: <base>/TaskChute/Task
    const base = this.resolveBase();
    return this.join(base, PathService.GROUP, PathService.SUBDIR.task);
  }

  getProjectFolderPath(): string | null {
    const raw = this.plugin.settings.projectsFolder;
    if (!raw) return null;
    return normalizePath(raw);
  }

  getLogDataPath(): string {
    const base = this.resolveBase();
    return this.join(base, PathService.GROUP, PathService.SUBDIR.log);
  }

  getReviewDataPath(): string {
    const base = this.resolveBase();
    return this.join(base, PathService.GROUP, PathService.SUBDIR.review);
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
      return {
        valid: false,
        error: t('paths.errors.absoluteNotAllowed', 'Absolute paths are not allowed'),
      };
    }
    if (path.includes("..")) {
      return {
        valid: false,
        error: t('paths.errors.parentSegmentNotAllowed', "Paths cannot include '..'"),
      };
    }
    if (path.match(/[<>"|?*]/)) {
      return {
        valid: false,
        error: t(
          'paths.errors.invalidCharacters',
          'Paths cannot contain special characters',
        ),
      };
    }
    return { valid: true };
  }

  async ensureFolderExists(path: string): Promise<void> {
    const folder = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!folder) {
      try {
        await this.plugin.app.vault.createFolder(path);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Folder already exists")
        ) {
          return;
        }
        throw error;
      }
    }
  }
}
