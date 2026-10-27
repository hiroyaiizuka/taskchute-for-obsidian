import type { App, Command } from 'obsidian'
import { t } from '@/i18n'
import { showConfirmModal } from '@/ui/modals/ConfirmModal'
import type { AiTaskManager } from './services/AiTaskManager'
import { restartAiTerminals } from './ui/restartAiTerminals'

interface AiTaskCommandHost {
  app: App
  addCommand(command: Command): Command
  /** Read when the command runs: the settings toggle replaces the manager. */
  aiTaskManager?: Pick<
    AiTaskManager,
    'canRestartTerminals' | 'countLiveTerminals' | 'restartTerminals'
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
      if (!manager?.canRestartTerminals()) return false
      if (!checking) {
        void restartAiTerminals(manager, (options) => showConfirmModal(host.app, options))
      }
      return true
    },
  })
}
