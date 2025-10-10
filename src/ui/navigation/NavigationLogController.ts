import type { WorkspaceLeaf } from 'obsidian'
import type { TaskChutePluginLike } from '../../types'
import { LogView } from '../../views/LogView'

const OVERLAY_CLASS = 'taskchute-log-modal-overlay'
const CONTAINER_CLASS = 'taskchute-log-modal-content'

export interface NavigationLogHost {
  plugin: TaskChutePluginLike
  leaf: WorkspaceLeaf
  navigationState: { selectedSection: string | null; isOpen: boolean }
}

export default class NavigationLogController {
  constructor(private readonly host: NavigationLogHost) {}

  openLogModal(): void {
    const existing = document.querySelector(`.${OVERLAY_CLASS}`)
    existing?.remove()

    const overlay = document.createElement('div')
    overlay.className = OVERLAY_CLASS
    const container = document.createElement('div')
    container.className = CONTAINER_CLASS
    overlay.appendChild(container)

    const close = () => {
      overlay.removeEventListener('click', handleOverlay)
      overlay.remove()
    }
    const handleOverlay = (event: MouseEvent) => {
      if (event.target === overlay) {
        close()
      }
    }
    overlay.addEventListener('click', handleOverlay)
    document.body.appendChild(overlay)

    const logView = new LogView(this.host.plugin, container)
    void logView.render()
    this.host.navigationState.selectedSection = 'log'
  }
}
