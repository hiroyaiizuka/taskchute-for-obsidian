import { Notice, TFile, TAbstractFile } from 'obsidian'
import type { App, CachedMetadata } from 'obsidian'
import RoutineService from '../../routine/services/RoutineService'
import { getScheduledTime } from '../../../utils/fieldMigration'
import {
  DayState,
  DeletedInstance,
  DuplicatedInstance,
  PathManagerLike,
  RoutineFrontmatter,
  TaskData,
  TaskInstance,
} from '../../../types'
import type { RoutineWeek } from '../../../types/TaskFields'
import DayStateStoreService from './DayStateStoreService'
import { extractTaskIdFromFrontmatter } from '../../../services/TaskIdManager'

interface TaskFrontmatterWithLegacy extends RoutineFrontmatter {
  estimatedMinutes?: number
  target_date?: string
  taskId?: string
  taskchuteId?: string
  tags?: string | string[]
  reminder_time?: string
}

interface TaskExecutionEntry {
  taskTitle?: string
  taskName?: string
  taskPath?: string
  instanceId?: string
  slotKey?: string
  startTime?: string
  stopTime?: string
  [key: string]: unknown
}

interface NormalizedExecution {
  taskTitle: string
  taskPath: string
  slotKey: string
  startTime?: string
  stopTime?: string
  instanceId?: string
}

interface DuplicatedRecord extends DuplicatedInstance {
  slotKey?: string
}

interface VaultStat {
  ctime?: number | Date
  mtime?: number | Date
}

export interface TaskLoaderHost {
  app: Pick<App, 'vault' | 'metadataCache'> & {
    vault: App['vault'] & {
      getAbstractFileByPath: (path: string) => TAbstractFile | null
      getMarkdownFiles?: () => TFile[]
      adapter: {
        stat: (path: string) => Promise<VaultStat | null | undefined>
      }
    }
    metadataCache: App['metadataCache'] & {
      getFileCache: (file: TFile) => CachedMetadata | null | undefined
    }
  }
  plugin: {
    settings: { slotKeys?: Record<string, string> }
    pathManager: PathManagerLike
  }
  dayStateManager: DayStateStoreService
  tasks: TaskData[]
  taskInstances: TaskInstance[]
  renderTaskList: () => void
  getCurrentDateString: () => string
  generateInstanceId: (task: TaskData, dateKey: string) => string
  isInstanceHidden?: (instanceId?: string, path?: string, dateKey?: string) => boolean
  isInstanceDeleted?: (instanceId?: string, path?: string, dateKey?: string, taskId?: string) => boolean
}

const DEFAULT_SLOT_KEY = 'none'

function resolveTaskId(metadata?: TaskFrontmatterWithLegacy | undefined): string | undefined {
  return extractTaskIdFromFrontmatter(metadata as Record<string, unknown> | undefined)
}

function promoteDeletedEntriesToTaskId(
  entries: DeletedInstance[],
  taskId: string,
  path: string,
): DeletedInstance[] | null {
  if (!taskId || !path) {
    return null
  }
  let mutated = false
  const promoted = entries.map((entry) => {
    if (!entry) return entry
    if (entry.taskId || entry.path !== path || entry.deletionType !== 'permanent') {
      return entry
    }
    mutated = true
    return { ...entry, taskId }
  })

  if (!mutated) {
    return null
  }

  const seen = new Set<string>()
  const deduped: DeletedInstance[] = []
  for (const entry of promoted) {
    if (!entry) continue
    if (entry.taskId && entry.deletionType === 'permanent') {
      if (seen.has(entry.taskId)) {
        continue
      }
      seen.add(entry.taskId)
    }
    deduped.push(entry)
  }
  return deduped
}

function getSlotOverrideValue(
  overrides: Record<string, string> | undefined,
  taskId: string | undefined,
  path: string,
): { value?: string; migrated: boolean } {
  if (!overrides) {
    return { migrated: false }
  }
  if (taskId && typeof overrides[taskId] === 'string') {
    return { value: overrides[taskId], migrated: false }
  }
  const legacy = overrides[path]
  if (legacy === undefined) {
    return { migrated: false }
  }
  if (taskId) {
    overrides[taskId] = legacy
    delete overrides[path]
    return { value: overrides[taskId], migrated: true }
  }
  return { value: legacy, migrated: false }
}

function getStoredSlotKey(
  slotKeys: Record<string, string> | undefined,
  taskId: string | undefined,
  path: string,
): string | undefined {
  if (!slotKeys) return undefined
  if (taskId && typeof slotKeys[taskId] === 'string') {
    return slotKeys[taskId]
  }
  return slotKeys[path]
}

function resolveCreatedMillis(file: TFile | null | undefined, fallback?: number): number | undefined {
  if (!file) {
    return fallback
  }
  const { ctime, mtime } = file.stat ?? {}
  if (typeof ctime === 'number' && Number.isFinite(ctime)) {
    return ctime
  }
  if (typeof mtime === 'number' && Number.isFinite(mtime)) {
    return mtime
  }
  return fallback
}

function resolveExecutionCreatedMillis(executions: NormalizedExecution[], dateKey: string): number | undefined {
  for (const execution of executions) {
    const start = parseDateTime(execution.startTime, dateKey)
    if (start) {
      return start.getTime()
    }
    const stop = parseDateTime(execution.stopTime, dateKey)
    if (stop) {
      return stop.getTime()
    }
  }
  return undefined
}

export class TaskLoaderService {
  async load(context: TaskLoaderHost): Promise<void> {
    await loadTasksForContext(context)
  }
}

export async function loadTasksForContext(context: TaskLoaderHost): Promise<void> {
  context.tasks = []
  context.taskInstances = []

  const dateKey = context.getCurrentDateString()

  try {
    const executions = await loadTodayExecutions(context, dateKey)
    const taskFiles = await getTaskFiles(context)

    const processedTitles = new Set<string>()
    const processedPaths = new Set<string>()

    for (const execution of executions) {
      if (processedTitles.has(execution.taskTitle)) continue
      processedTitles.add(execution.taskTitle)

      const matchedFile = taskFiles.find(
        (file) => (execution.taskPath && file.path === execution.taskPath) || file.basename === execution.taskTitle,
      ) ?? null

      const groupedExecutions = executions.filter((entry) => entry.taskTitle === execution.taskTitle)
      const hadVisibleInstance = await createTaskFromExecutions(context, groupedExecutions, matchedFile, dateKey)
      if (hadVisibleInstance && matchedFile) {
        processedPaths.add(matchedFile.path)
      }
    }

    for (const file of taskFiles) {
      if (processedPaths.has(file.path)) continue

      const frontmatter = getFrontmatter(context, file)
      const content = await context.app.vault.read(file)
      if (!isTaskFile(content, frontmatter)) continue

      if (frontmatter?.isRoutine === true) {
        if (shouldShowRoutineTask(frontmatter, dateKey)) {
          await createRoutineTask(context, file, frontmatter, dateKey)
        }
      } else {
        const shouldShow = await shouldShowNonRoutineTask(context, file, frontmatter, dateKey)
        if (shouldShow) {
          await createNonRoutineTask(context, file, frontmatter, dateKey)
        }
      }
    }

    await addDuplicatedInstances(context, dateKey)
    context.renderTaskList()
  } catch (error) {
    console.error('Failed to load tasks', error)
    new Notice('タスクの読み込みに失敗しました')
  }
}

async function loadTodayExecutions(context: TaskLoaderHost, dateKey: string): Promise<NormalizedExecution[]> {
  try {
    const logDataPath = context.plugin.pathManager.getLogDataPath()
    const [year, month] = dateKey.split('-')
    const logFilePath = `${logDataPath}/${year}-${month}-tasks.json`
    const abstract = context.app.vault.getAbstractFileByPath(logFilePath)
    if (!abstract || !(abstract instanceof TFile)) {
      return []
    }

    const raw = await context.app.vault.read(abstract)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as {
      taskExecutions?: Record<string, TaskExecutionEntry[]>
    } | null

    const entries = Array.isArray(parsed?.taskExecutions?.[dateKey])
      ? parsed.taskExecutions[dateKey]
      : []

    return entries.map((entry): NormalizedExecution => {
      const taskTitle = toStringField(entry.taskTitle ?? entry.taskName) ?? 'Untitled Task'
      const taskPath = toStringField(entry.taskPath) ?? ''
      const slotKey = toStringField(entry.slotKey) ?? calculateSlotKeyFromTime(entry.startTime) ?? DEFAULT_SLOT_KEY
      return {
        taskTitle,
        taskPath,
        slotKey,
        startTime: toStringField(entry.startTime),
        stopTime: toStringField(entry.stopTime),
        instanceId: toStringField(entry.instanceId) ?? undefined,
      }
    })
  } catch (error) {
    console.warn('Failed to load today executions', error)
    return []
  }
}

function createTaskFromExecutions(
  context: TaskLoaderHost,
  executions: NormalizedExecution[],
  file: TFile | null,
  dateKey: string,
): boolean {
  if (executions.length === 0) {
    return false
  }

  const metadata = file ? getFrontmatter(context, file) : undefined
  const projectInfo = resolveProjectInfo(context, metadata)
  const templateName = file?.basename ?? executions[0].taskTitle
  const derivedPath = file?.path ?? executions[0].taskPath ?? `${templateName}.md`
  const createdMillis = resolveCreatedMillis(file, resolveExecutionCreatedMillis(executions, dateKey))
  const taskId = resolveTaskId(metadata)

  const taskData: TaskData = {
    file,
    frontmatter: metadata ?? {},
    path: derivedPath,
    name: templateName,
    displayTitle: deriveDisplayTitle(file, metadata, executions[0]?.taskTitle),
    project: toStringField(metadata?.project),
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: metadata?.isRoutine === true,
    createdMillis,
    routine_type: metadata?.routine_type,
    routine_interval: typeof metadata?.routine_interval === 'number' ? metadata.routine_interval : undefined,
    routine_enabled: metadata?.routine_enabled,
    scheduledTime: getScheduledTime(metadata) || undefined,
    taskId,
  }

  let created = 0
  for (const execution of executions) {
    const instance: TaskInstance = {
      task: taskData,
      instanceId: execution.instanceId ?? context.generateInstanceId(taskData, dateKey),
      state: 'done',
      slotKey: execution.slotKey,
      date: dateKey,
      startTime: parseDateTime(execution.startTime, dateKey),
      stopTime: parseDateTime(execution.stopTime, dateKey),
      executedTitle: execution.taskTitle,
      createdMillis,
    }

    if (isVisibleInstance(context, instance.instanceId, taskData.path, dateKey, taskData.taskId)) {
      context.taskInstances.push(instance)
      created += 1
    }
  }

  if (created > 0) {
    context.tasks.push(taskData)
  }

  return created > 0
}

function createNonRoutineTask(
  context: TaskLoaderHost,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy | undefined,
  dateKey: string,
): void {
  const projectInfo = resolveProjectInfo(context, metadata)
  const createdMillis = resolveCreatedMillis(file, Date.now())
  const taskId = resolveTaskId(metadata)
  const taskData: TaskData = {
    file,
    frontmatter: metadata ?? {},
    path: file.path,
    name: file.basename,
    displayTitle: deriveDisplayTitle(file, metadata, file.basename),
    project: toStringField(metadata?.project),
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: false,
    createdMillis,
    scheduledTime: getScheduledTime(metadata) || undefined,
    reminder_time: metadata?.reminder_time,
    taskId,
  }

  context.tasks.push(taskData)

  const storedSlot = getStoredSlotKey(context.plugin.settings.slotKeys, taskId, file.path)
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? DEFAULT_SLOT_KEY
  const instance: TaskInstance = {
    task: taskData,
    instanceId: context.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
    createdMillis,
  }

  if (isVisibleInstance(context, instance.instanceId, file.path, dateKey, taskData.taskId)) {
    context.taskInstances.push(instance)
  }
}

function normalizeRoutineWeeks(metadata: TaskFrontmatterWithLegacy): RoutineWeek[] | undefined {
  const routineWeeksRaw = (metadata as Record<string, unknown>).routine_weeks
  const monthlyWeeksRaw = (metadata as Record<string, unknown>).monthly_weeks
  const seen = new Set<string>()
  const result: RoutineWeek[] = []

  const pushWeek = (week: RoutineWeek): void => {
    const key = String(week)
    if (seen.has(key)) return
    seen.add(key)
    result.push(week)
  }

  if (Array.isArray(routineWeeksRaw)) {
    routineWeeksRaw.forEach((value) => {
      if (value === 'last') {
        pushWeek('last')
      } else {
        const num = Number(value)
        if (Number.isInteger(num) && num >= 1 && num <= 5) {
          pushWeek(num as RoutineWeek)
        }
      }
    })
  } else if (Array.isArray(monthlyWeeksRaw)) {
    monthlyWeeksRaw.forEach((value) => {
      if (value === 'last') {
        pushWeek('last')
      } else {
        const num = Number(value)
        if (Number.isInteger(num)) {
          const normalized = (num + 1)
          if (normalized >= 1 && normalized <= 5) {
            pushWeek(normalized as RoutineWeek)
          }
        }
      }
    })
  }

  return result.length ? result : undefined
}

function normalizeRoutineWeekdays(metadata: TaskFrontmatterWithLegacy): number[] | undefined {
  const routineWeekdaysRaw = (metadata as Record<string, unknown>).routine_weekdays
  const monthlyWeekdaysRaw = (metadata as Record<string, unknown>).monthly_weekdays
  const raw = Array.isArray(routineWeekdaysRaw) ? routineWeekdaysRaw : Array.isArray(monthlyWeekdaysRaw) ? monthlyWeekdaysRaw : undefined
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<number>()
  const result: number[] = []
  raw.forEach((value) => {
    const num = Number(value)
    if (Number.isInteger(num) && num >= 0 && num <= 6 && !seen.has(num)) {
      seen.add(num)
      result.push(num)
    }
  })
  return result.length ? result : undefined
}

async function createRoutineTask(
  context: TaskLoaderHost,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy,
  dateKey: string,
): Promise<void> {
  const rule = RoutineService.parseFrontmatter(metadata)
  if (!rule || rule.enabled === false) return

  const dayState = await ensureDayState(context, dateKey)
  const projectInfo = resolveProjectInfo(context, metadata)
  const createdMillis = resolveCreatedMillis(file, Date.now())
  const taskId = resolveTaskId(metadata)

  const taskData: TaskData = {
    file,
    frontmatter: metadata,
    path: file.path,
    name: file.basename,
    displayTitle: deriveDisplayTitle(file, metadata, file.basename),
    project: toStringField(metadata.project),
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: true,
    createdMillis,
    routine_type: rule.type,
    routine_interval: rule.interval,
    routine_enabled: rule.enabled,
    routine_start: metadata.routine_start,
    routine_end: metadata.routine_end,
    routine_week: metadata.routine_week,
    routine_weekday: metadata.routine_weekday,
    weekdays: Array.isArray(metadata.weekdays)
      ? metadata.weekdays.filter((value): value is number => Number.isInteger(value))
      : undefined,
    routine_weeks: normalizeRoutineWeeks(metadata),
    routine_weekdays: normalizeRoutineWeekdays(metadata),
    scheduledTime: getScheduledTime(metadata) || undefined,
    reminder_time: metadata.reminder_time,
    taskId,
  }

  context.tasks.push(taskData)

  const { value: storedSlot } = getSlotOverrideValue(dayState.slotOverrides, taskId, file.path)
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? DEFAULT_SLOT_KEY
  const instance: TaskInstance = {
    task: taskData,
    instanceId: context.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
    createdMillis,
  }

  if (isVisibleInstance(context, instance.instanceId, file.path, dateKey, taskData.taskId)) {
    context.taskInstances.push(instance)
  }
}

function shouldShowRoutineTask(
  metadata: TaskFrontmatterWithLegacy,
  dateKey: string,
): boolean {
  // target_date is deprecated but still used for backwards compatibility with existing data
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- backwards compatibility with legacy target_date field
  const movedTargetDate = metadata.target_date && metadata.target_date !== metadata.routine_start
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- backwards compatibility with legacy target_date field
    ? metadata.target_date
    : undefined
  const rule = RoutineService.parseFrontmatter(metadata)
  return RoutineService.isDue(dateKey, rule, movedTargetDate)
}

async function shouldShowNonRoutineTask(
  context: TaskLoaderHost,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy | undefined,
  dateKey: string,
): Promise<boolean> {
  const originalEntries = getDeletedInstancesForDate(context, dateKey)
  const taskId = resolveTaskId(metadata)

  let deletedEntries = originalEntries
  if (taskId) {
    const promoted = promoteDeletedEntriesToTaskId(originalEntries, taskId, file.path)
    if (promoted) {
      deletedEntries = promoted
      context.dayStateManager.setDeleted(promoted, dateKey)
    }

    const hasTaskIdDeletion = deletedEntries.some(
      (entry) => entry.deletionType === 'permanent' && entry.taskId === taskId,
    )

    if (hasTaskIdDeletion) {
      return false
    }
  }

  const legacyPathDeletions = deletedEntries.filter(
    (entry) => entry.deletionType === 'permanent' && !entry.taskId && entry.path === file.path,
  )

  let missingDeletionTimestamp = false
  let latestDeletionTimestamp: number | undefined
  for (const entry of legacyPathDeletions) {
    if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
      latestDeletionTimestamp =
        latestDeletionTimestamp === undefined
          ? entry.timestamp
          : Math.max(latestDeletionTimestamp, entry.timestamp)
    } else {
      missingDeletionTimestamp = true
    }
  }

  let cachedCreatedMillis: number | null | undefined
  const resolveFileCreatedMillis = async (): Promise<number | null> => {
    if (cachedCreatedMillis !== undefined) {
      return cachedCreatedMillis
    }
    try {
      const stats = await context.app.vault.adapter.stat(file.path)
      if (!stats) {
        cachedCreatedMillis = null
        return cachedCreatedMillis
      }
      const raw = stats.ctime ?? stats.mtime
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        cachedCreatedMillis = raw
        return cachedCreatedMillis
      }
      if (raw instanceof Date && Number.isFinite(raw.getTime())) {
        cachedCreatedMillis = raw.getTime()
        return cachedCreatedMillis
      }
      cachedCreatedMillis = null
      return cachedCreatedMillis
    } catch (error) {
      console.warn('Failed to determine task visibility', error)
      cachedCreatedMillis = null
      return cachedCreatedMillis
    }
  }

  if (legacyPathDeletions.length > 0) {
    if (missingDeletionTimestamp) {
      return false
    }
    const createdMillis = await resolveFileCreatedMillis()
    if (createdMillis === null) {
      return false
    }
    if (latestDeletionTimestamp === undefined || createdMillis <= latestDeletionTimestamp) {
      return false
    }
    const remainingEntries = deletedEntries.filter((entry) => {
      if (entry.deletionType !== 'permanent') {
        return true
      }
      if (entry.taskId) {
        return true
      }
      return entry.path !== file.path
    })
    if (remainingEntries.length !== deletedEntries.length) {
      context.dayStateManager.setDeleted(remainingEntries, dateKey)
      deletedEntries = remainingEntries
    }
  }

  // target_date is deprecated but still used for backwards compatibility with existing data
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- backwards compatibility with legacy target_date field
  if (metadata?.target_date) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- backwards compatibility with legacy target_date field
    return metadata.target_date === dateKey
  }

  const createdMillis = await resolveFileCreatedMillis()
  if (createdMillis === null) {
    return false
  }
  const createdKey = formatDate(new Date(createdMillis))
  return createdKey === dateKey
}

async function addDuplicatedInstances(context: TaskLoaderHost, dateKey: string): Promise<void> {
  try {
    const dayState = await ensureDayState(context, dateKey)
    const records = Array.isArray(dayState.duplicatedInstances)
      ? (dayState.duplicatedInstances as DuplicatedRecord[])
      : []

    for (const record of records) {
      const { instanceId, originalPath, slotKey } = record
      if (!instanceId || !originalPath) continue
      if (context.taskInstances.some((instance) => instance.instanceId === instanceId)) {
        continue
      }

      const createdMillis = record.createdMillis ?? record.timestamp ?? Date.now()

      let taskData = context.tasks.find((task) => task.path === originalPath)
      if (!taskData) {
        const file = context.app.vault.getAbstractFileByPath(originalPath)
        if (file instanceof TFile) {
          const metadata = getFrontmatter(context, file)
          if (metadata) {
            const projectInfo = resolveProjectInfo(context, metadata)
            taskData = {
              file,
              frontmatter: metadata,
              path: originalPath,
              name: file.basename,
              displayTitle: deriveDisplayTitle(file, metadata, file.basename),
              project: toStringField(metadata.project),
              projectPath: projectInfo?.path,
              projectTitle: projectInfo?.title,
              isRoutine: metadata.isRoutine === true,
              scheduledTime: getScheduledTime(metadata) || undefined,
              taskId: record.originalTaskId ?? resolveTaskId(metadata),
            }
          }
        }
      }

      if (!taskData) {
        const fallbackName = originalPath.split('/').pop()?.replace(/\.md$/u, '') ?? originalPath
        taskData = {
          file: null,
          frontmatter: {},
          path: originalPath,
          name: fallbackName,
          displayTitle: deriveDisplayTitle(null, undefined, fallbackName),
          isRoutine: false,
          taskId: record.originalTaskId,
        }
      }

      if (!taskData.taskId && record.originalTaskId) {
        taskData.taskId = record.originalTaskId
      }

      context.tasks.push(taskData)

      const instance: TaskInstance = {
        task: taskData,
        instanceId,
        state: 'idle',
        slotKey: slotKey ?? DEFAULT_SLOT_KEY,
        date: dateKey,
        createdMillis,
      }

      if (isVisibleInstance(context, instance.instanceId, taskData.path, dateKey, taskData.taskId)) {
        context.taskInstances.push(instance)
      }
    }
  } catch (error) {
    console.error('Failed to restore duplicated instances', error)
  }
}

async function ensureDayState(context: TaskLoaderHost, dateKey: string): Promise<DayState> {
  const manager = context.dayStateManager
  if (manager) {
    return await manager.ensure(dateKey)
  }
  return createEmptyDayState()
}

function getDeletedInstancesForDate(context: TaskLoaderHost, dateKey: string): DeletedInstance[] {
  const manager = context.dayStateManager
  if (manager) {
    return manager.getDeleted(dateKey) ?? []
  }
  return []
}

function isVisibleInstance(
  context: TaskLoaderHost,
  instanceId: string,
  path: string,
  dateKey: string,
  taskId?: string,
): boolean {
  const manager = context.dayStateManager
  if (manager?.isDeleted({ instanceId, path, dateKey, taskId })) {
    return false
  }
  if (manager?.isHidden({ instanceId, path, dateKey })) {
    return false
  }

  if (context.isInstanceDeleted?.(instanceId, path, dateKey, taskId)) {
    return false
  }
  if (context.isInstanceHidden?.(instanceId, path, dateKey)) {
    return false
  }
  return true
}

function resolveProjectInfo(
  context: TaskLoaderHost,
  metadata: TaskFrontmatterWithLegacy | undefined,
): { path?: string; title?: string } | undefined {
  if (!metadata) return undefined

  const explicitPath = toStringField(
    (metadata as Record<string, unknown>).project_path,
  )
  if (explicitPath) {
    return {
      path: explicitPath,
      title: extractProjectTitle(metadata.project),
    }
  }

  const title = extractProjectTitle(metadata.project)
  if (!title) return undefined

  const candidates = context.app.vault.getMarkdownFiles?.() ?? []
  const file = candidates.find((candidate) => candidate.basename === title)
  if (!file) return { title }
  return { title, path: file.path }
}

function extractProjectTitle(projectField: unknown): string | undefined {
  const value = toStringField(projectField)
  if (!value) return undefined
  const wikilinkMatch = value.match(/\[\[([^\]]+)\]\]/u)
  if (wikilinkMatch) {
    return wikilinkMatch[1]
  }
  return value
}

function getFrontmatter(context: TaskLoaderHost, file: TFile): TaskFrontmatterWithLegacy | undefined {
  const cache = context.app.metadataCache.getFileCache(file)
  return cache?.frontmatter as TaskFrontmatterWithLegacy | undefined
}

export function isTaskFile(content: string, frontmatter: TaskFrontmatterWithLegacy | undefined): boolean {
  // Check for #task tag in content (legacy support)
  if (content.includes('#task')) return true
  // Check for 'task' in frontmatter tags (new format)
  if (frontmatter?.tags) {
    const tags = frontmatter.tags
    if (Array.isArray(tags) && tags.includes('task')) return true
    if (typeof tags === 'string' && tags === 'task') return true
  }
  // Legacy: check for estimatedMinutes
  if (frontmatter?.estimatedMinutes) return true
  return false
}

function deriveDisplayTitle(
  file: TFile | null,
  metadata: TaskFrontmatterWithLegacy | undefined,
  fallbackTitle: string | undefined,
): string {
  const frontmatterTitle = toStringField((metadata as Record<string, unknown> | undefined)?.title)
  if (frontmatterTitle) return frontmatterTitle
  if (file) return file.basename
  const executionTitle = toStringField(fallbackTitle)
  if (executionTitle) return executionTitle
  return 'Untitled Task'
}

function getTaskFiles(context: TaskLoaderHost): TFile[] {
  const folderPath = context.plugin.pathManager.getTaskFolderPath()
  const abstract = context.app.vault.getAbstractFileByPath(folderPath)

  const collected: TFile[] = []

  if (abstract && typeof abstract === 'object' && 'children' in abstract) {
    const children = (abstract as { children?: unknown[] }).children ?? []
    for (const child of children) {
      if (isMarkdownFile(child)) {
        collected.push(child)
      }
    }
  }

  if (collected.length > 0) {
    return collected
  }

  const markdownFiles = context.app.vault.getMarkdownFiles?.() ?? []
  return markdownFiles.filter((file) => file.path.startsWith(`${folderPath}/`))
}

function isMarkdownFile(candidate: unknown): candidate is TFile {
  if (candidate instanceof TFile) {
    return candidate.extension === 'md'
  }
  if (!candidate || typeof candidate !== 'object') {
    return false
  }
  const maybe = candidate as { path?: unknown; extension?: unknown }
  return (
    typeof maybe.path === 'string' &&
    typeof maybe.extension === 'string' &&
    maybe.extension === 'md'
  )
}

function toStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function calculateSlotKeyFromTime(time: string | undefined): string | undefined {
  if (!time) return undefined
  const [hourStr] = time.split(':')
  const hour = Number.parseInt(hourStr ?? '', 10)
  if (Number.isNaN(hour)) return undefined
  if (hour >= 0 && hour < 8) return '0:00-8:00'
  if (hour >= 8 && hour < 12) return '8:00-12:00'
  if (hour >= 12 && hour < 16) return '12:00-16:00'
  if (hour >= 16 && hour < 24) return '16:00-0:00'
  return undefined
}

function getScheduledSlotKey(time: string | undefined): string | undefined {
  return calculateSlotKeyFromTime(time)
}

function parseDateTime(time: string | undefined, dateKey: string): Date | undefined {
  if (!time) return undefined
  const [year, month, day] = dateKey.split('-').map((value) => Number.parseInt(value, 10))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined
  }
  const [hours, minutes, seconds] = time.split(':').map((value) => Number.parseInt(value, 10))
  return new Date(
    year,
    month - 1,
    day,
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    Number.isFinite(seconds) ? seconds : 0,
  )
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function createEmptyDayState(): DayState {
  return {
    hiddenRoutines: [],
    deletedInstances: [],
    duplicatedInstances: [],
    slotOverrides: {},
    orders: {},
  }
}
