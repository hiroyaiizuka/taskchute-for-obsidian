// @ts-nocheck
import { Notice, TFile } from 'obsidian';
import RoutineService from '../services/RoutineService';
import { getScheduledTime } from '../utils/fieldMigration';
import type {
  DayState,
  DeletedInstance,
  DuplicatedInstance,
  RoutineFrontmatter,
  TaskData,
  TaskInstance,
} from '../types';
import type { TaskChuteView } from './TaskChuteView';

interface TaskFrontmatterWithLegacy extends RoutineFrontmatter {
  estimatedMinutes?: number;
  target_date?: string;
}

interface TaskExecutionEntry {
  taskTitle?: string;
  taskName?: string;
  taskPath?: string;
  instanceId?: string;
  slotKey?: string;
  startTime?: string;
  stopTime?: string;
  [key: string]: unknown;
}

interface NormalizedExecution {
  taskTitle: string;
  taskPath: string;
  slotKey: string;
  startTime?: string;
  stopTime?: string;
  instanceId?: string;
}

interface DuplicatedRecord extends DuplicatedInstance {
  slotKey?: string;
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

export async function loadTasksRefactored(this: TaskChuteView): Promise<void> {
  this.tasks = [];
  this.taskInstances = [];

  const dateKey = this.getCurrentDateString();

  try {
    const executions = await loadTodayExecutions.call(this, dateKey);
    const taskFiles = await getTaskFiles.call(this);

    const processedTitles = new Set<string>();
    const processedPaths = new Set<string>();

    for (const execution of executions) {
      if (processedTitles.has(execution.taskTitle)) continue;
      processedTitles.add(execution.taskTitle);

      const matchedFile = taskFiles.find(
        (file) => (execution.taskPath && file.path === execution.taskPath) || file.basename === execution.taskTitle,
      ) ?? null;

      const groupedExecutions = executions.filter((entry) => entry.taskTitle === execution.taskTitle);
      const hadVisibleInstance = await createTaskFromExecutions.call(this, groupedExecutions, matchedFile, dateKey);
      if (hadVisibleInstance && matchedFile) {
        processedPaths.add(matchedFile.path);
      }
    }

    for (const file of taskFiles) {
      if (processedPaths.has(file.path)) continue;

      const frontmatter = getFrontmatter(this, file);
      const content = await this.app.vault.read(file);
      if (!isTaskFile(content, frontmatter)) continue;

      if (frontmatter?.isRoutine === true) {
        if (shouldShowRoutineTask.call(this, frontmatter, dateKey)) {
          await createRoutineTask.call(this, file, frontmatter, dateKey);
        }
      } else {
        const shouldShow = await shouldShowNonRoutineTask.call(this, file, frontmatter, dateKey);
        if (shouldShow) {
          await createNonRoutineTask.call(this, file, frontmatter, dateKey);
        }
      }
    }

    await addDuplicatedInstances.call(this, dateKey);
    this.renderTaskList();
  } catch (error) {
    console.error('Failed to load tasks', error);
    new Notice('タスクの読み込みに失敗しました');
  }
}

async function getTaskFiles(this: TaskChuteView): Promise<TFile[]> {
  const folderPath = this.plugin.pathManager.getTaskFolderPath();
  const abstract = this.app.vault.getAbstractFileByPath(folderPath);

  const collected: TFile[] = [];

  if (abstract && typeof abstract === 'object' && 'children' in abstract) {
    const children = (abstract as { children: unknown[] }).children ?? [];
    for (const child of children) {
      if (isMarkdownFile(child)) {
        collected.push(child);
      }
    }
  }

  if (collected.length > 0) {
    return collected;
  }

  const markdownFiles = typeof this.app.vault.getMarkdownFiles === 'function'
    ? this.app.vault.getMarkdownFiles()
    : [];
  return markdownFiles.filter((file) => file.path.startsWith(`${folderPath}/`));
}

function isMarkdownFile(candidate: unknown): candidate is TFile {
  if (candidate instanceof TFile) {
    return candidate.extension === 'md';
  }
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const maybe = candidate as { path?: unknown; extension?: unknown };
  return (
    typeof maybe.path === 'string' &&
    typeof maybe.extension === 'string' &&
    maybe.extension === 'md'
  );
}

async function loadTodayExecutions(this: TaskChuteView, dateKey: string): Promise<NormalizedExecution[]> {
  try {
    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const [year, month] = dateKey.split('-');
    const logFilePath = `${logDataPath}/${year}-${month}-tasks.json`;
    const abstract = this.app.vault.getAbstractFileByPath(logFilePath);
    if (!abstract || !(abstract instanceof TFile)) {
      return [];
    }

    const raw = await this.app.vault.read(abstract);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as {
      taskExecutions?: Record<string, TaskExecutionEntry[]>;
    } | null;

    const entries = Array.isArray(parsed?.taskExecutions?.[dateKey])
      ? parsed!.taskExecutions![dateKey]!
      : [];

    return entries.map((entry): NormalizedExecution => {
      const taskTitle = toStringField(entry.taskTitle ?? entry.taskName) ?? 'Untitled Task';
      const taskPath = toStringField(entry.taskPath) ?? '';
      const slotKey = toStringField(entry.slotKey) ?? calculateSlotKeyFromTime(entry.startTime) ?? 'none';
      return {
        taskTitle,
        taskPath,
        slotKey,
        startTime: toStringField(entry.startTime),
        stopTime: toStringField(entry.stopTime),
        instanceId: toStringField(entry.instanceId) ?? undefined,
      };
    });
  } catch (error) {
    console.warn('Failed to load today executions', error);
    return [];
  }
}

async function createTaskFromExecutions(
  this: TaskChuteView,
  executions: NormalizedExecution[],
  file: TFile | null,
  dateKey: string,
): Promise<boolean> {
  if (executions.length === 0) {
    return false;
  }

  const metadata = file ? getFrontmatter(this, file) : undefined;
  const projectInfo = resolveProjectInfo(this, metadata);
  const templateName = file?.basename ?? executions[0].taskTitle;
  const derivedPath = file?.path ?? executions[0].taskPath ?? `${templateName}.md`;

  const taskData: TaskData = {
    file,
    frontmatter: metadata ?? {},
    path: derivedPath,
    name: templateName,
    displayTitle: deriveDisplayTitle(file, metadata, executions[0].taskTitle),
    project: metadata?.project,
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: metadata?.isRoutine === true,
    routine_type: metadata?.routine_type,
    routine_start: metadata?.routine_start,
    routine_end: metadata?.routine_end,
    routine_week: metadata?.routine_week,
    routine_weekday: metadata?.routine_weekday,
    routine_interval: typeof metadata?.routine_interval === 'number' ? metadata.routine_interval : undefined,
    routine_enabled: metadata?.routine_enabled,
    scheduledTime: getScheduledTime(metadata) || undefined,
  };

  let created = 0;
  for (const execution of executions) {
    const instance: TaskInstance = {
      task: taskData,
      instanceId: execution.instanceId ?? this.generateInstanceId(taskData, dateKey),
      state: 'done',
      slotKey: execution.slotKey,
      date: dateKey,
      startTime: parseDateTime(execution.startTime, dateKey),
      stopTime: parseDateTime(execution.stopTime, dateKey),
      executedTitle: execution.taskTitle,
    };

    if (isVisibleInstance.call(this, instance.instanceId, taskData.path, dateKey)) {
      this.taskInstances.push(instance);
      created += 1;
    }
  }

  if (created > 0) {
    this.tasks.push(taskData);
  }

  return created > 0;
}

async function createNonRoutineTask(
  this: TaskChuteView,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy | undefined,
  dateKey: string,
): Promise<void> {
  const projectInfo = resolveProjectInfo(this, metadata);
  const taskData: TaskData = {
    file,
    frontmatter: metadata ?? {},
    path: file.path,
    name: file.basename,
    displayTitle: deriveDisplayTitle(file, metadata, file.basename),
    project: metadata?.project,
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: false,
    scheduledTime: getScheduledTime(metadata) || undefined,
  };

  this.tasks.push(taskData);

  const storedSlot = this.plugin.settings.slotKeys?.[file.path];
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? 'none';
  const instance: TaskInstance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
  };

  if (isVisibleInstance.call(this, instance.instanceId, file.path, dateKey)) {
    this.taskInstances.push(instance);
  }
}

async function createRoutineTask(
  this: TaskChuteView,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy,
  dateKey: string,
): Promise<void> {
  const rule = RoutineService.parseFrontmatter(metadata);
  if (!rule || rule.enabled === false) return;

  await this.ensureDayStateForCurrentDate();
  const dayState = this.getCurrentDayState();
  const projectInfo = resolveProjectInfo(this, metadata);

  const taskData: TaskData = {
    file,
    frontmatter: metadata,
    path: file.path,
    name: file.basename,
    displayTitle: deriveDisplayTitle(file, metadata, file.basename),
    project: metadata.project,
    projectPath: projectInfo?.path,
    projectTitle: projectInfo?.title,
    isRoutine: true,
    routine_type: rule.type,
    routine_interval: rule.interval,
    routine_enabled: rule.enabled,
    routine_start: metadata.routine_start,
    routine_end: metadata.routine_end,
    routine_week: metadata.routine_week,
    routine_weekday: metadata.routine_weekday,
    scheduledTime: getScheduledTime(metadata) || undefined,
  };

  this.tasks.push(taskData);

  const storedSlot = dayState.slotOverrides?.[file.path];
  const slotKey = storedSlot ?? getScheduledSlotKey(getScheduledTime(metadata)) ?? 'none';
  const instance: TaskInstance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData, dateKey),
    state: 'idle',
    slotKey,
    date: dateKey,
  };

  if (isVisibleInstance.call(this, instance.instanceId, file.path, dateKey)) {
    this.taskInstances.push(instance);
  }
}

function shouldShowRoutineTask(
  this: TaskChuteView,
  metadata: TaskFrontmatterWithLegacy,
  dateKey: string,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const movedTargetDate = metadata.target_date && metadata.target_date !== metadata.routine_start
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    ? metadata.target_date
    : undefined;
  const rule = RoutineService.parseFrontmatter(metadata);
  return RoutineService.isDue(dateKey, rule, movedTargetDate);
}

async function shouldShowNonRoutineTask(
  this: TaskChuteView,
  file: TFile,
  metadata: TaskFrontmatterWithLegacy | undefined,
  dateKey: string,
): Promise<boolean> {
  const deleted = getDeletedInstancesForDate.call(this, dateKey)
    .some((entry) => entry.deletionType === 'permanent' && entry.path === file.path);
  if (deleted) return false;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (metadata?.target_date) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return metadata.target_date === dateKey;
  }

  try {
    const stats = await this.app.vault.adapter.stat(file.path);
    if (!stats) return false;

    const created = new Date(stats.ctime ?? stats.mtime ?? Date.now());
    const createdKey = formatDate(created);
    return createdKey === dateKey;
  } catch (error) {
    console.warn('Failed to determine task visibility', error);
    return false;
  }
}

async function addDuplicatedInstances(this: TaskChuteView, dateKey: string): Promise<void> {
  try {
    const dayState = await fetchDayState.call(this, dateKey);
    const records = Array.isArray(dayState?.duplicatedInstances)
      ? (dayState!.duplicatedInstances as DuplicatedRecord[])
      : [];

    for (const record of records) {
      const { instanceId, originalPath, slotKey } = record;
      if (!instanceId || !originalPath) continue;
      if (this.taskInstances.some((instance) => instance.instanceId === instanceId)) {
        continue;
      }

      let taskData = this.tasks.find((task) => task.path === originalPath);
      if (!taskData) {
        const file = this.app.vault.getAbstractFileByPath(originalPath);
        if (file instanceof TFile) {
          const metadata = getFrontmatter(this, file);
          if (metadata) {
            const projectInfo = resolveProjectInfo(this, metadata);
            taskData = {
              file,
              frontmatter: metadata,
              path: originalPath,
              name: file.basename,
              displayTitle: deriveDisplayTitle(file, metadata, file.basename),
              project: metadata.project,
              projectPath: projectInfo?.path,
              projectTitle: projectInfo?.title,
              isRoutine: metadata.isRoutine === true,
              scheduledTime: getScheduledTime(metadata) || undefined,
            };
          }
        }
      }

      if (!taskData) {
        const fallbackName = originalPath.split('/').pop()?.replace(/\.md$/u, '') ?? originalPath;
        taskData = {
          file: null,
          frontmatter: {},
          path: originalPath,
          name: fallbackName,
          displayTitle: deriveDisplayTitle(null, undefined, fallbackName),
          isRoutine: false,
        };
      }

      this.tasks.push(taskData);

      const instance: TaskInstance = {
        task: taskData,
        instanceId,
        state: 'idle',
        slotKey: slotKey ?? 'none',
        date: dateKey,
      };

      if (isVisibleInstance.call(this, instance.instanceId, taskData.path, dateKey)) {
        this.taskInstances.push(instance);
      }
    }
  } catch (error) {
    console.error('Failed to restore duplicated instances', error);
  }
}

async function fetchDayState(this: TaskChuteView, dateKey: string): Promise<DayState | null> {
  if (typeof (this as TaskChuteView & { getDayStateSnapshot?(date: string): DayState | null }).getDayStateSnapshot === 'function') {
    const snapshot = (this as TaskChuteView & { getDayStateSnapshot?(date: string): DayState | null }).getDayStateSnapshot!(dateKey);
    if (snapshot) return snapshot;
  }

  if (typeof (this as TaskChuteView & { getDayState?(date: string): Promise<DayState | null> }).getDayState === 'function') {
    return (this as TaskChuteView & { getDayState?(date: string): Promise<DayState | null> }).getDayState!(dateKey);
  }

  return null;
}

function getDeletedInstancesForDate(this: TaskChuteView, dateKey: string): DeletedInstance[] {
  if (typeof this.getDeletedInstances === 'function') {
    const result = this.getDeletedInstances(dateKey);
    return Array.isArray(result) ? result : [];
  }
  return [];
}

function isVisibleInstance(this: TaskChuteView, instanceId: string, path: string, dateKey: string): boolean {
  const deleted = typeof this.isInstanceDeleted === 'function'
    ? this.isInstanceDeleted(instanceId, path, dateKey)
    : false;
  if (deleted) return false;

  const hidden = typeof this.isInstanceHidden === 'function'
    ? this.isInstanceHidden(instanceId, path, dateKey)
    : false;
  return !hidden;
}

function resolveProjectInfo(
  view: TaskChuteView,
  metadata: TaskFrontmatterWithLegacy | undefined,
): { path?: string; title?: string } | undefined {
  if (!metadata) return undefined;
  if (typeof metadata.project_path === 'string') {
    return {
      path: metadata.project_path,
      title: extractProjectTitle(metadata.project),
    };
  }

  const title = extractProjectTitle(metadata.project);
  if (!title) return undefined;

  const file = view.app.vault.getMarkdownFiles().find((candidate) => candidate.basename === title);
  if (!file) return { title };
  return { title, path: file.path };
}

function extractProjectTitle(projectField: string | undefined): string | undefined {
  if (!projectField) return undefined;
  const wikilinkMatch = projectField.match(/\[\[([^\]]+)\]\]/u);
  if (wikilinkMatch) {
    return wikilinkMatch[1];
  }
  return projectField;
}

function getFrontmatter(view: TaskChuteView, file: TFile): TaskFrontmatterWithLegacy | undefined {
  const cache = view.app.metadataCache.getFileCache(file);
  return cache?.frontmatter as TaskFrontmatterWithLegacy | undefined;
}

function isTaskFile(content: string, frontmatter: TaskFrontmatterWithLegacy | undefined): boolean {
  if (content.includes('#task')) return true;
  if (frontmatter?.estimatedMinutes) return true;
  return false;
}

function toStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function calculateSlotKeyFromTime(time: string | undefined): string | undefined {
  if (!time) return undefined;
  const [hourStr] = time.split(':');
  const hour = Number.parseInt(hourStr ?? '', 10);
  if (Number.isNaN(hour)) return undefined;
  if (hour >= 0 && hour < 8) return '0:00-8:00';
  if (hour >= 8 && hour < 12) return '8:00-12:00';
  if (hour >= 12 && hour < 16) return '12:00-16:00';
  if (hour >= 16 && hour < 24) return '16:00-0:00';
  return undefined;
}

function getScheduledSlotKey(time: string | undefined): string | undefined {
  return calculateSlotKeyFromTime(time);
}

function parseDateTime(time: string | undefined, dateKey: string): Date | undefined {
  if (!time) return undefined;
  const [year, month, day] = dateKey.split('-').map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  const [hours, minutes, seconds] = time.split(':').map((value) => Number.parseInt(value, 10));
  return new Date(
    year,
    month - 1,
    day,
    Number.isFinite(hours) ? hours : 0,
    Number.isFinite(minutes) ? minutes : 0,
    Number.isFinite(seconds) ? seconds : 0,
  );
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
