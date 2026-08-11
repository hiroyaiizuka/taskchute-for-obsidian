import type { TFile } from 'obsidian'

/**
 * Shape for routine task data used in UI components.
 * Explicitly defined to avoid type inference issues from index signatures.
 */
export interface RoutineTaskShape {
  path: string
  name: string
  file?: TFile | null
  frontmatter?: Record<string, unknown>
  displayTitle?: string
  title?: string
  isRoutine?: boolean
  scheduledTime?: string
  routine_type?: 'daily' | 'weekly' | 'monthly' | 'monthly_date' | 'weekdays' | 'weekends'
  routine_interval?: number
  routine_enabled?: boolean
  routine_start?: string
  routine_end?: string
  weekdays?: number[]
  weekday?: number
  monthly_week?: number | 'last'
  monthly_weekday?: number
  routine_weeks?: (number | 'last')[]
  routine_weekdays?: number[]
  routine_week?: number | 'last'
  routine_weekday?: number
  routine_monthday?: number | 'last'
  routine_monthdays?: Array<number | 'last'>
  /** Japanese frontmatter compatibility */
  開始時刻?: string
  projectPath?: string
  projectTitle?: string
}
