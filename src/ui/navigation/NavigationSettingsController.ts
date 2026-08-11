import type { App } from 'obsidian'

export interface NavigationSettingsHost {
  app: Pick<App, 'setting'>
  pluginId: string
  notifyFailure: (message: string) => void
}

export default class NavigationSettingsController {
  constructor(private readonly host: NavigationSettingsHost) {}

  openSettings(): void {
    try {
      const settingApi = this.host.app.setting
      if (settingApi && this.host.pluginId) {
        settingApi.open()
        settingApi.openTabById(this.host.pluginId)
      } else {
        throw new Error('Settings API unavailable')
      }
    } catch (error) {
      console.warn('[Navigation] Failed to open settings', error)
      this.host.notifyFailure('Unable to open TaskChute settings')
    }
  }
}
