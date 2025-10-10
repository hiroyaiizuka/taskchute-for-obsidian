import type { TaskData } from './index'

export type RoutineTaskShape = Pick<
  TaskData,
  | 'path'
  | 'isRoutine'
  | 'scheduledTime'
  | 'routine_type'
  | 'routine_interval'
  | 'routine_enabled'
  | 'weekdays'
  | 'weekday'
  | 'monthly_week'
  | 'monthly_weekday'
  | 'displayTitle'
  | 'name'
  | 'title'
  | 'frontmatter'
  | 'file'
> & {
  /** Japanese frontmatter compatibility */
  開始時刻?: string
  projectPath?: string
  projectTitle?: string
  [key: string]: unknown
}
