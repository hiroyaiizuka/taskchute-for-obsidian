import type { TaskChuteView } from '../../TaskChuteView'
import type { TaskLoaderHost } from '../../../services/TaskLoaderService'

export async function loadTasksRefactored(this: TaskChuteView & TaskLoaderHost): Promise<void> {
  await this.taskLoader.load(this)
}
