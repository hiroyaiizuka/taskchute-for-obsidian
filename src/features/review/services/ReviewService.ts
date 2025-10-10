import { TFile, WorkspaceLeaf, Notice } from 'obsidian'
import type { TaskChutePluginLike } from '../../../types'
import { buildDefaultReviewTemplate } from '../utils/reviewTemplate'
import { t } from '../../../i18n'

export class ReviewService {
  private readonly plugin: TaskChutePluginLike;

  constructor(plugin: TaskChutePluginLike) {
    this.plugin = plugin;
  }

  getReviewFileName(dateStr: string): string {
    // Current spec uses "Daily - YYYY-MM-DD.md"
    return `Daily - ${dateStr}.md`;
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

    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const content = buildDefaultReviewTemplate(logDataPath);
    const created = await this.plugin.app.vault.create(reviewPath, content);
    if (!(created instanceof TFile)) {
      throw new Error(`Failed to create review file at ${reviewPath}`);
    }
    return created;
  }

  async openInSplit(file: TFile, leftLeaf: WorkspaceLeaf): Promise<void> {
    try {
      const { workspace } = this.plugin.app;
      const splitFunction = (workspace as { splitActiveLeaf?: (direction: 'vertical' | 'horizontal') => WorkspaceLeaf | null }).splitActiveLeaf;
      const rightLeaf =
        typeof splitFunction === 'function'
          ? splitFunction.call(workspace, 'vertical')
          : workspace.getLeaf('split');

      if (!rightLeaf) {
        throw new Error('Could not open review file in split view');
      }

      await rightLeaf.openFile(file);
      // Return focus to the left TaskChute view
      workspace.setActiveLeaf(leftLeaf);
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
}
