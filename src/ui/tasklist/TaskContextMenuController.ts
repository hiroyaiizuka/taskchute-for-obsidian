import { Menu, type App } from 'obsidian'
import type { TaskInstance } from '../../types'

type AsyncValue<T> = Promise<T> | T

export interface TaskContextMenuHost {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  app: App
  startInstance: (inst: TaskInstance) => AsyncValue<void>
  stopInstance: (inst: TaskInstance) => AsyncValue<void>
  resetTaskToIdle: (inst: TaskInstance) => AsyncValue<void>
  duplicateInstance: (inst: TaskInstance) => AsyncValue<TaskInstance | void>
  deleteRoutineTask: (inst: TaskInstance) => AsyncValue<void>
  deleteNonRoutineTask: (inst: TaskInstance) => AsyncValue<void>
  hasExecutionHistory: (path: string) => AsyncValue<boolean>
}

export default class TaskContextMenuController {
  constructor(private readonly host: TaskContextMenuHost) {}

  show(event: MouseEvent, inst: TaskInstance): void {
    const menu = new Menu()

    if (inst.state === 'idle') {
      this.addAsyncItem(menu, this.host.tv('buttons.start', 'Start'), async () => {
        await this.host.startInstance(inst)
      }, 'play')
    }

    if (inst.state === 'running') {
      this.addAsyncItem(menu, this.host.tv('buttons.stop', 'Stop'), async () => {
        await this.host.stopInstance(inst)
      }, 'pause')
    }

    if (inst.state !== 'idle') {
      this.addAsyncItem(
        menu,
        this.host.tv('buttons.resetToNotStarted', 'Reset to not started'),
        async () => {
          await this.host.resetTaskToIdle(inst)
        },
        'rotate-ccw',
      )
    }

    this.addAsyncItem(menu, this.host.tv('buttons.duplicateTask', 'Duplicate task'), async () => {
      await this.host.duplicateInstance(inst)
    }, 'copy')

    this.addAsyncItem(menu, this.host.tv('buttons.deleteTask', 'Delete task'), async () => {
      const path = inst.task.path ?? ''
      const hasHistory = path ? await this.host.hasExecutionHistory(path) : false
      if (inst.task.isRoutine || hasHistory) {
        await this.host.deleteRoutineTask(inst)
      } else {
        await this.host.deleteNonRoutineTask(inst)
      }
    }, 'trash')

    menu.showAtMouseEvent(event)
  }

  private addAsyncItem(
    menu: Menu,
    title: string,
    handler: () => AsyncValue<void>,
    icon?: string,
  ): void {
    menu.addItem((item) => {
      item.setTitle(title)
      if (icon) {
        item.setIcon(icon)
      }
      item.onClick(() => {
        void Promise.resolve(handler()).catch((error) => {
          console.error('[TaskContextMenu]', 'action failed', error)
        })
      })
    })
  }
}
