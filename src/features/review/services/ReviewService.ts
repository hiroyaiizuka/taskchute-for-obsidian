import { TFile, WorkspaceLeaf, Notice } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import { t } from '../../../i18n'

export class ReviewService {
  private readonly plugin: TaskChutePluginLike;

  constructor(plugin: TaskChutePluginLike) {
    this.plugin = plugin;
  }

  getReviewFileName(dateStr: string): string {
    const pattern = this.plugin.settings.reviewFileNamePattern?.trim() || 'Review - {{date}}.md';
    const replaced = replaceDateTokens(pattern, dateStr);
    const fileName = replaced.endsWith('.md') ? replaced : `${replaced}.md`;
    return fileName;
  }

  getReviewFilePath(dateStr: string): string {
    const folder = this.plugin.pathManager.getReviewDataPath();
    const fileName = this.getReviewFileName(dateStr);
    return `${folder}/${fileName}`;
  }

  async ensureReviewFile(dateStr: string): Promise<TFile> {
    const reviewFolder = this.plugin.pathManager.getReviewDataPath();
    await this.plugin.pathManager.ensureFolderExists(reviewFolder);

    const reviewPath = this.getReviewFilePath(dateStr);
    const existing = this.plugin.app.vault.getAbstractFileByPath(reviewPath);
    if (existing && existing instanceof TFile) return existing;

    const content = await this.generateReviewContent(dateStr);
    const created = await this.plugin.app.vault.create(reviewPath, content);
    if (!isTFileLike(created)) {
      throw new Error(`Failed to create review file at ${reviewPath}`);
    }
    return created;
  }

  async openInSplit(file: TFile, _leftLeaf: WorkspaceLeaf): Promise<void> {
    try {
      const { workspace } = this.plugin.app;
      const workspaceWithSplit = workspace as { splitActiveLeaf?: (direction: 'vertical' | 'horizontal') => WorkspaceLeaf | null };
      const splitFunction = workspaceWithSplit.splitActiveLeaf;
      const rightLeaf: WorkspaceLeaf | null =
        typeof splitFunction === 'function'
          ? (splitFunction.call(workspace, 'vertical') as WorkspaceLeaf | null)
          : workspace.getLeaf('split');

      if (!rightLeaf) {
        throw new Error('Could not open review file in split view');
      }

      await rightLeaf.openFile(file);
      if (typeof (workspace as { revealLeaf?: (leaf: WorkspaceLeaf) => void }).revealLeaf === 'function') {
        void workspace.revealLeaf(rightLeaf);
      } else {
        workspace.setActiveLeaf(rightLeaf);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(
        t('notices.reviewDisplayFailed', 'Failed to display review: {message}', {
          message,
        }),
      );
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private async generateReviewContent(dateStr: string): Promise<string> {
    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const configured = this.plugin.settings.reviewTemplatePath?.trim();

    if (configured) {
      try {
        const abstract = this.plugin.app.vault.getAbstractFileByPath(configured);
        if (isTFileLike(abstract)) {
          const template = await this.plugin.app.vault.read(abstract);
          return this.applyTemplateVariables(template, dateStr, logDataPath);
        }
        this.notifyMissingTemplate(configured);
      } catch (error) {
        this.notifyTemplateReadFailed(configured, error);
      }
      return '';
    }

    return '';
  }

  private applyTemplateVariables(template: string, dateStr: string, logDataPath: string): string {
    const withDates = replaceDateTokens(template, dateStr);
    return withDates.replaceAll('{{logDataPath}}', logDataPath);
  }

  private notifyMissingTemplate(path: string): void {
    this.plugin._log?.('warn', '[TaskChute] Review template not found:', path);
    this.plugin._notify?.(
      t('notices.reviewTemplateMissing', 'Review template file was not found: {path}', {
        path,
      }),
    );
  }

  private notifyTemplateReadFailed(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.plugin._log?.('warn', '[TaskChute] Failed to read review template:', path, error);
    this.plugin._notify?.(
      t('notices.reviewTemplateReadFailed', 'Failed to read review template: {message}', {
        message,
      }),
    );
  }
}

function isTFileLike(value: unknown): value is TFile {
  if (value instanceof TFile) return true;
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { path?: unknown }).path === 'string';
}

function replaceDateTokens(template: string, dateStr: string): string {
  const [year = '', month = '', day = ''] = dateStr.split('-');
  return template
    .replaceAll('{{date}}', dateStr)
    .replaceAll('{{year}}', year)
    .replaceAll('{{month}}', month)
    .replaceAll('{{day}}', day);
}
