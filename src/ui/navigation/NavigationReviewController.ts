import { ReviewService } from '../../features/review/services/ReviewService'
import type { WorkspaceLeaf, TFile } from 'obsidian'
import type { TaskChutePluginLike } from '../../types'

export interface NavigationReviewHost {
  app: {
    vault: {
      getMarkdownFiles: () => TFile[]
    }
  }
  plugin: TaskChutePluginLike
  leaf: WorkspaceLeaf
  navigationState: { selectedSection: string | null; isOpen: boolean }
  getCurrentDateString?: () => string
}

export default class NavigationReviewController {
  constructor(private readonly host: NavigationReviewHost) {}

  private getDateKey(): string {
    const today = new Date()
    const dateKey = this.host.getCurrentDateString?.()
    if (typeof dateKey === 'string' && dateKey.length > 0) {
      return dateKey
    }
    const year = today.getFullYear()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  async showReviewSection(): Promise<void> {
    const service = new ReviewService(this.host.plugin)
    const file = await service.ensureReviewFile(this.getDateKey())
    await service.openInSplit(file, this.host.leaf)
    this.host.navigationState.selectedSection = 'review'
  }
}
