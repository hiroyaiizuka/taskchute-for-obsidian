import { TFile, WorkspaceLeaf, Notice } from 'obsidian';
import { buildDefaultReviewTemplate } from '../utils/reviewTemplate';

export class ReviewService {
  private plugin: any;

  constructor(plugin: any) {
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
    const file = await this.plugin.app.vault.create(reviewPath, content);
    return file as TFile;
  }

  async openInSplit(file: TFile, leftLeaf: WorkspaceLeaf): Promise<void> {
    try {
      const ws: any = this.plugin.app.workspace as any;
      const rightLeaf: WorkspaceLeaf =
        typeof ws.splitActiveLeaf === 'function'
          ? ws.splitActiveLeaf('vertical')
          : (this.plugin.app.workspace.getLeaf('split') as WorkspaceLeaf);

      await rightLeaf.openFile(file);
      // Return focus to the left TaskChute view
      this.plugin.app.workspace.setActiveLeaf(leftLeaf);
    } catch (error: any) {
      new Notice('レビューの表示に失敗しました: ' + (error?.message || error));
      throw error;
    }
  }
}

