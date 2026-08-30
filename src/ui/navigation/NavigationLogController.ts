import { App, Modal, type WorkspaceLeaf } from 'obsidian'
import type { TaskChutePluginLike } from '../../types'
import { LogView } from '../../features/log/views/LogView'

export interface NavigationLogHost {
  plugin: TaskChutePluginLike
  leaf: WorkspaceLeaf
  navigationState: { selectedSection: string | null; isOpen: boolean }
}

/**
 * Hosts the log view, which draws its own header and stacks its sections
 * vertically. Sizing comes from `.taskchute-log-modal` rather than Obsidian's
 * `mod-sidebar-layout`: that modifier lays `.modal-content` out as a flex row,
 * which is right for a sidebar beside a pane but puts the log's header,
 * heatmap and detail panel side by side.
 */
class LogModal extends Modal {
  constructor(app: App, private readonly plugin: TaskChutePluginLike) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('taskchute-modal', 'taskchute-log-modal')
    const view = new LogView(this.plugin, this.contentEl, () => this.close())
    void view.render()
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

export default class NavigationLogController {
  private modal: LogModal | null = null

  constructor(private readonly host: NavigationLogHost) {}

  openLogModal(): void {
    this.modal?.close()
    this.modal = new LogModal(this.host.plugin.app, this.host.plugin)
    this.modal.open()
    this.host.navigationState.selectedSection = 'log'
  }
}
