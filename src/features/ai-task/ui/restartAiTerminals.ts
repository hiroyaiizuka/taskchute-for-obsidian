import { Notice } from 'obsidian'
import { t } from '@/i18n'
import type { ConfirmModalOptions } from '@/ui/modals/ConfirmModal'
import type { AiTaskManager } from '../services/AiTaskManager'

type RestartableManager = Pick<AiTaskManager, 'countLiveTerminals' | 'restartTerminals'>

/**
 * Restart the AI terminals on the user's request (LEV-405): from the
 * failed-start banner, or the "Restart AI terminals" command. Running
 * terminals end, so the user confirms first when there are any.
 */
export async function restartAiTerminals(
  manager: RestartableManager,
  confirm: (options: ConfirmModalOptions) => Promise<boolean>,
): Promise<void> {
  const count = manager.countLiveTerminals()
  if (count > 0) {
    const confirmed = await confirm({
      title: t('taskChuteView.aiTask.restartTerminals.confirmTitle', 'Restart terminals?'),
      message: t(
        'taskChuteView.aiTask.restartTerminals.confirmMessage',
        '{count} running terminal(s) will end. Then the process that runs terminals (the broker) starts over.',
        { count },
      ),
      confirmText: t('taskChuteView.aiTask.restartTerminals.confirm', 'Restart'),
      destructive: true,
    })
    if (!confirmed) return
  }
  try {
    await manager.restartTerminals()
    new Notice(
      t(
        'taskChuteView.aiTask.restartTerminals.done',
        'Terminals restarted. You can open a new terminal now.',
      ),
    )
  } catch (error) {
    new Notice(
      t('taskChuteView.aiTask.restartTerminals.failed', 'Terminals could not be restarted: {error}', {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
