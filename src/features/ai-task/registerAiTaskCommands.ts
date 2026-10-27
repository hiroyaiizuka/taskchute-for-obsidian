import type { App, Command } from 'obsidian'
import { t } from '@/i18n'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import type { AiTaskManager } from './services/AiTaskManager'
import { restartAiTerminals } from './ui/restartAiTerminals'

interface AiTaskCommandHost {
  app: App
  addCommand(command: Command): Command
  /**
   * Read when the command runs: the settings toggle replaces the manager.
   * A manager kept from before a plugin update may lack these methods.
   */
  aiTaskManager?: Partial<
    Pick<AiTaskManager, 'canRestartTerminals' | 'countLiveTerminals' | 'restartTerminals'>
  >
}

/**
 * "Restart AI terminals" (LEV-405): a way out whenever the broker that runs
 * the terminals stops working, whatever the reason. Listed only while the
 * terminals run in a broker.
 */
export function registerAiTaskCommands(host: AiTaskCommandHost): void {
  host.addCommand({
    id: 'restart-ai-terminals',
    name: t('commands.restartAiTerminals', 'Restart AI terminals'),
    checkCallback: (checking) => {
      const manager = host.aiTaskManager
      if (
        typeof manager?.canRestartTerminals !== 'function' ||
        typeof manager.countLiveTerminals !== 'function' ||
        typeof manager.restartTerminals !== 'function' ||
        !manager.canRestartTerminals()
      ) {
        return false
      }
      if (!checking) {
        void restartAiTerminals(
          {
            countLiveTerminals: () => manager.countLiveTerminals?.() ?? 0,
            restartTerminals: () => manager.restartTerminals?.() ?? Promise.resolve(),
          },
          (options) => showConfirmModal(host.app, options),
        )
      }
      return true
    },
  })
}
