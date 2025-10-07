import { Notice } from "obsidian";

import { t } from "../../i18n";
import type { TaskChutePluginLike } from "../../types";

export function openSettingsModal(plugin: TaskChutePluginLike): void {
  const settingApi = plugin.app.setting;

  if (!settingApi) {
    plugin._log?.("warn", "[TaskChute] Settings API is unavailable")
    new Notice(t("settings.openFailed", "Unable to open TaskChute settings"))
    return
  }

  try {
    settingApi.open()
    settingApi.openTabById(plugin.manifest.id)
  } catch (error) {
    plugin._log?.("warn", "[TaskChute] Failed to open settings tab", error)
    new Notice(
      t(
        "settings.openFailed",
        "Unable to open TaskChute settings",
      ),
    )
  }
}
