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
import DayStateStoreService from './DayStateStoreService'

interface TaskFrontmatterWithLegacy extends RoutineFrontmatter {
  estimatedMinutes?: number
  target_date?: string
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
  ctime?: number
  mtime?: number
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
  isInstanceDeleted?: (instanceId?: string, path?: string, dateKey?: string) => boolean
}

const DEFAULT_SLOT_KEY = 'none'

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
      ? parsed!.taskExecutions![dateKey]!
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

async function createTaskFromExecutions(
  context: TaskLoaderHost,
  executions: NormalizedExecution[],
  file: TFile | null,
  dateKey: string,
): Promise<boolean> {
  if (executions.length === 0) {
    return false
  }

  const metadata = file ? getFrontmatter(context, file) : undefined
  const projectInfo = resolveProjectInfo(context, metadata)
  const templateName = file?.basename ?? executions[0]!.taskTitle
  const derivedPath = file?.path ?? executions[0]!.taskPath ?? `${templateName}.md`
  const createdMillis = resolveCreatedMillis(file, resolveExecutionCreatedMillis(executions, dateKey))

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

    if (isVisibleInstance(context, instance.instanceId, taskData.path, dateKey)) {
      context.taskInstances.push(instance)
      created += 1
    }
  }

  if (created > 0) {
    context.tasks.push(taskData)
  }

  return created > 0
}

async function createNonRoutineTask(
  context: TaskLoaderHost,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy | undefined,
  dateKey: string,
): Promise<void> {
  const projectInfo = resolveProjectInfo(context, metadata)
  const createdMillis = resolveCreatedMillis(file, Date.now())
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
  }

  context.tasks.push(taskData)

  const storedSlot = context.plugin.settings.slotKeys?.[file.path]
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? DEFAULT_SLOT_KEY
  const instance: TaskInstance = {
    task: taskData,
    instanceId: context.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
    createdMillis,
  }

  if (isVisibleInstance(context, instance.instanceId, file.path, dateKey)) {
    context.taskInstances.push(instance)
  }
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
    scheduledTime: getScheduledTime(metadata) || undefined,
  }

  context.tasks.push(taskData)

  const storedSlot = dayState.slotOverrides?.[file.path]
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? DEFAULT_SLOT_KEY
  const instance: TaskInstance = {
    task: taskData,
    instanceId: context.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
    createdMillis,
  }

  if (isVisibleInstance(context, instance.instanceId, file.path, dateKey)) {
    context.taskInstances.push(instance)
  }
}

function shouldShowRoutineTask(
  metadata: TaskFrontmatterWithLegacy,
  dateKey: string,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const movedTargetDate = metadata.target_date && metadata.target_date !== metadata.routine_start
    // eslint-disable-next-line @typescript-eslint/no-deprecated
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
  const deleted = getDeletedInstancesForDate(context, dateKey)
    .some((entry) => entry.deletionType === 'permanent' && entry.path === file.path)
  if (deleted) return false

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (metadata?.target_date) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return metadata.target_date === dateKey
  }

  try {
    const stats = await context.app.vault.adapter.stat(file.path)
    if (!stats) return false

    const created = new Date(stats.ctime ?? stats.mtime ?? Date.now())
    const createdKey = formatDate(created)
    return createdKey === dateKey
  } catch (error) {
    console.warn('Failed to determine task visibility', error)
    return false
  }
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
        }
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

      if (isVisibleInstance(context, instance.instanceId, taskData.path, dateKey)) {
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
    return manager.ensure(dateKey)
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

function isVisibleInstance(context: TaskLoaderHost, instanceId: string, path: string, dateKey: string): boolean {
  const manager = context.dayStateManager
  if (manager?.isDeleted({ instanceId, path, dateKey })) {
    return false
  }
  if (manager?.isHidden({ instanceId, path, dateKey })) {
    return false
  }

  if (context.isInstanceDeleted?.(instanceId, path, dateKey)) {
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

function isTaskFile(content: string, frontmatter: TaskFrontmatterWithLegacy | undefined): boolean {
  if (content.includes('#task')) return true
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

async function getTaskFiles(context: TaskLoaderHost): Promise<TFile[]> {
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
