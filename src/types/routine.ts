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
  | 'routine_weeks'
  | 'routine_weekdays'
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
  routine_weeks?: (number | 'last')[]
  routine_weekdays?: number[]
  [key: string]: unknown
}
