import type { TaskChuteView } from '../views/TaskChuteView'
import type { TaskLoaderHost } from '../../../features/core/services/TaskLoaderService'

export async function loadTasksRefactored(this: TaskChuteView & TaskLoaderHost): Promise<void> {
  await this.taskLoader.load(this)
}
