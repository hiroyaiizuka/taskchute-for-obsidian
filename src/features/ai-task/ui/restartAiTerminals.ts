import { Notice } from 'obsidian'
import { t } from '@/i18n'
import type { ConfirmModalOptions } from '@/ui/modals/ConfirmModal'
import type { AiTaskManager } from '../services/AiTaskManager'

type RestartableManager = Pick<AiTaskManager, 'countLiveTerminals' | 'restartTerminals'> &
  Partial<Pick<AiTaskManager, 'countLiveTerminalTasks'>>

/**
 * Restart the AI terminals on the user's request (LEV-405): from the
 * failed-start banner, or the "Restart AI terminals" command. Running
 * terminals end, so the user confirms first when there are any.
 *
 * `stopTaskTimers` stops the timers of the AI tasks running in them first, as
 * their stop button would (a TaskChute view does it). Only then does the
 * confirmation say those tasks will stop and be marked done.
 */
export async function restartAiTerminals(
  manager: RestartableManager,
  confirm: (options: ConfirmModalOptions) => Promise<boolean>,
  stopTaskTimers?: () => Promise<void>,
): Promise<void> {
  const count = manager.countLiveTerminals()
  if (count > 0) {
    const tasks = stopTaskTimers ? (manager.countLiveTerminalTasks?.() ?? 0) : 0
    const message =
      tasks > 0
        ? t(
            'taskChuteView.aiTask.restartTerminals.confirmMessageWithTasks',
            '{count} running terminal(s) will end. {tasks} running AI task(s) among them will stop and be marked done, as with their stop button. Then new terminals can start fresh.',
            { count, tasks },
          )
        : t(
            'taskChuteView.aiTask.restartTerminals.confirmMessage',
            '{count} running terminal(s) will end. Then new terminals can start fresh.',
            { count },
          )
    const confirmed = await confirm({
      title: t('taskChuteView.aiTask.restartTerminals.confirmTitle', 'Restart terminals?'),
      message,
      confirmText: t('taskChuteView.aiTask.restartTerminals.confirm', 'Restart'),
      destructive: true,
    })
    if (!confirmed) return
  }
  try {
    await stopTaskTimers?.()
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
