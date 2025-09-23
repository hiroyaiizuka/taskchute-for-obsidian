// Refactored loadTasks implementation with proper filtering
import RoutineService from '../services/RoutineService';

export async function loadTasksRefactored(this: any): Promise<void> {
  this.tasks = [];
  this.taskInstances = [];

  try {
    const dateString = this.getCurrentDateString();
    
    // Load today's executions from log
    const todayExecutions = await loadTodayExecutions.call(this, dateString);
    
    // Get task folder
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const taskFolder = this.app.vault.getAbstractFileByPath(taskFolderPath);
    
    if (!taskFolder) {
      this.renderTaskList();
      return;
    }

    // Get all task files
    const taskFiles = taskFolder.children.filter(
      (file: any) => file.extension === "md"
    );

    // Track processed task names to avoid duplicate execution grouping
    const processedTaskNames = new Set<string>();
    // Only mark a file as processed if at least one visible instance was materialized
    const processedFilePaths = new Set<string>();

    // First, process tasks from execution history
    for (const exec of todayExecutions) {
      if (processedTaskNames.has(exec.taskTitle)) continue;
      processedTaskNames.add(exec.taskTitle);

      // Find the task file (prefer exact path, fallback to basename)
      const taskFile = taskFiles.find((f: any) =>
        (exec.taskPath && f.path === exec.taskPath) || f.basename === exec.taskTitle
      );

      // Group all executions for this title
      const taskExecutions = todayExecutions.filter(
        (e: any) => e.taskTitle === exec.taskTitle
      );

      // Create from executions; only mark file as processed if something was actually rendered
      const hadVisible = await createTaskFromExecutions.call(this, taskExecutions, taskFile, dateString);
      if (hadVisible && taskFile) {
        processedFilePaths.add(taskFile.path);
      }
    }

    // Then, process tasks that haven't been executed today (routine and non-routine)
    for (const file of taskFiles) {
      // Skip only if first phase actually materialized something for this path
      if (processedFilePaths.has(file.path)) continue;
      
      const content = await this.app.vault.read(file);
      const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
      
      // Check if it's a task file
      if (!content.includes("#task") && !metadata?.estimatedMinutes) {
        continue;
      }
      
      // Check if it's a routine task (isRoutine only; no fallbacks)
      const isRoutine = metadata?.isRoutine === true;
      
      if (isRoutine) {
        // Process routine task
        if (shouldShowRoutineTask.call(this, metadata, this.currentDate, dateString)) {
          await createRoutineTask.call(this, file, content, metadata, dateString);
        }
      } else {
        // Process non-routine task - only show if conditions are met
        const shouldShow = await shouldShowNonRoutineTask.call(this, file, metadata, dateString);
        if (shouldShow) {
          await createNonRoutineTask.call(this, file, content, metadata, dateString);
        }
    }
    }
    
    // Add duplicated (unexecuted) instances recorded in day state for the day
    await addDuplicatedInstances.call(this, dateString);

    this.renderTaskList();
  } catch (error) {
    console.error("Failed to load tasks:", error);
    new (this.app.constructor as any).Notice("タスクの読み込みに失敗しました");
  }
}

async function loadTodayExecutions(this: any, dateString: string): Promise<any[]> {
  try {
    const logDataPath = this.plugin.pathManager.getLogDataPath();
    const [year, month] = dateString.split('-');
    const monthString = `${year}-${month}`;
    const logPath = `${logDataPath}/${monthString}-tasks.json`;
    
    const logFile = this.app.vault.getAbstractFileByPath(logPath);
    if (!logFile) {
      return [];
    }

    const content = await this.app.vault.read(logFile);
    const monthlyLog = JSON.parse(content);
    
    // Get executions for the specific date
    const dayExecutions = monthlyLog.taskExecutions?.[dateString] || [];
    
    return dayExecutions.map((exec: any) => ({
      taskTitle: exec.taskTitle || exec.taskName,
      taskPath: exec.taskPath || '',
      startTime: exec.startTime,
      stopTime: exec.stopTime,
      slotKey: exec.slotKey || calculateSlotKeyFromTime(exec.startTime),
      instanceId: exec.instanceId,
    }));
  } catch (error) {
    console.error('Failed to load today executions:', error);
    return [];
  }
}

function calculateSlotKeyFromTime(timeStr: string): string {
  if (!timeStr) return "none";
  
  const [hourStr] = timeStr.split(':');
  const hour = parseInt(hourStr, 10);
  
  if (hour >= 0 && hour < 8) return "0:00-8:00";
  if (hour >= 8 && hour < 12) return "8:00-12:00";
  if (hour >= 12 && hour < 16) return "12:00-16:00";
  if (hour >= 16 && hour < 24) return "16:00-0:00";
  
  return "none";
}

// Returns true if at least one visible instance was created
async function createTaskFromExecutions(this: any, executions: any[], file: any, dateString: string): Promise<boolean> {
  const metadata = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
  
  // Extract project info
  let projectPath = null;
  let projectTitle = null;
  
  // First check if project_path is already set
  if (metadata?.project_path) {
    projectPath = metadata.project_path;
    projectTitle = extractProjectTitle(metadata.project);
  } else if (metadata?.project) {
    projectTitle = extractProjectTitle(metadata.project);
    if (projectTitle) {
      const allFiles = this.app.vault.getMarkdownFiles();
      const projectFile = allFiles.find(f => f.basename === projectTitle);
      if (projectFile) {
        projectPath = projectFile.path;
      }
    }
  }
  
  // Derive stable identifiers
  const first = executions[0] || {};
  const derivedName = (file?.basename) 
    || (typeof first.taskTitle === 'string' && first.taskTitle) 
    || (typeof first.taskPath === 'string' && first.taskPath.split('/').pop()?.replace(/\.md$/, '')) 
    || 'Unknown Task';
  const derivedPath = (file?.path)
    || (typeof first.taskPath === 'string' && first.taskPath)
    || `TaskChute/Task/${derivedName}.md`;

  const taskData = {
    file: file || null,
    frontmatter: metadata || {},
    path: derivedPath,
    name: derivedName,
    title: derivedName,
    project: metadata?.project,
    projectPath: projectPath,
    projectTitle: projectTitle,
    isRoutine: metadata?.isRoutine === true || false,
    routineType: metadata?.routine_type,
    scheduledTime: metadata?.開始時刻,
    isVirtual: !file,
  };

  let created = 0;
  // Create instances for each execution
  for (const exec of executions) {
    const instance = {
      task: taskData,
      instanceId: exec.instanceId || this.generateInstanceId(taskData.path),
      state: 'done',
      slotKey: exec.slotKey,
      date: dateString,
      startTime: parseTimeString(exec.startTime, dateString),
      stopTime: parseTimeString(exec.stopTime, dateString),
      executedTitle: exec.taskTitle,
    };

    // Check if deleted or hidden
    const isDeleted = isInstanceDeleted.call(this, instance.instanceId, taskData.path, dateString);
    const isHidden = isInstanceHidden.call(this, instance.instanceId, taskData.path, dateString);
    
    if (!isDeleted && !isHidden) {
      this.taskInstances.push(instance);
      created++;
    }
  }

  // Only register task data if at least one instance is visible
  if (created > 0) {
    this.tasks.push(taskData);
  }

  return created > 0;
}

async function createNonRoutineTask(this: any, file: any, content: string, metadata: any, dateString: string): Promise<void> {
  // Extract project info
  let projectPath = null;
  let projectTitle = null;
  
  // First check if project_path is already set
  if (metadata?.project_path) {
    projectPath = metadata.project_path;
    projectTitle = extractProjectTitle(metadata.project);
  } else if (metadata?.project) {
    projectTitle = extractProjectTitle(metadata.project);
    if (projectTitle) {
      const allFiles = this.app.vault.getMarkdownFiles();
      const projectFile = allFiles.find(f => f.basename === projectTitle);
      if (projectFile) {
        projectPath = projectFile.path;
      }
    }
  }
  
  const taskData = {
    file,
    frontmatter: metadata || {},
    path: file.path,
    name: file.basename,
    title: file.basename,
    project: metadata?.project,
    projectPath: projectPath,
    projectTitle: projectTitle,
    isRoutine: false,
    scheduledTime: metadata?.開始時刻,
  };

  this.tasks.push(taskData);

  // Create idle instance for non-routine task
  const storedSlot = this.plugin?.settings?.slotKeys?.[file.path];
  const slotKey = storedSlot || getScheduledSlotKey(metadata?.開始時刻) || 'none';
  const instance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData.path),
    state: 'idle',
    slotKey,
    date: dateString,
  };

  // Check if deleted for today (path-level only). Do NOT hide due to duplicate-instance deletion.
  const isDeleted = isInstanceDeleted.call(this, '', file.path, dateString);

  if (!isDeleted) {
    this.taskInstances.push(instance);
  }

}

async function createRoutineTask(this: any, file: any, content: string, metadata: any, dateString: string): Promise<void> {
  const rule = RoutineService.parseFrontmatter(metadata);
  if (!rule || rule.enabled === false) return;
  // Extract project info
  let projectPath = null;
  let projectTitle = null;
  
  // First check if project_path is already set
  if (metadata?.project_path) {
    projectPath = metadata.project_path;
    projectTitle = extractProjectTitle(metadata.project);
  } else if (metadata?.project) {
    projectTitle = extractProjectTitle(metadata.project);
    if (projectTitle) {
      const allFiles = this.app.vault.getMarkdownFiles();
      const projectFile = allFiles.find(f => f.basename === projectTitle);
      if (projectFile) {
        projectPath = projectFile.path;
      }
    }
  }
  
  const taskData = {
    file,
    frontmatter: metadata || {},
    path: file.path,
    name: file.basename,
    title: file.basename,
    project: metadata?.project,
    projectPath: projectPath,
    projectTitle: projectTitle,
    isRoutine: true,
    routineType: rule.type,
    routine_type: rule.type,
    routine_interval: rule.interval,
    routine_enabled: rule.enabled,
    routine_start: metadata?.routine_start,
    routine_end: metadata?.routine_end,
    scheduledTime: metadata?.開始時刻,
    // Backward compat fields used elsewhere in UI
    weekday: metadata?.weekday ?? metadata?.routine_weekday ?? (rule as any).weekday,
    weekdays: metadata?.weekdays,
    monthlyWeek: metadata?.monthly_week ?? metadata?.routine_week ?? (rule as any).week,
    monthlyWeekday: metadata?.monthly_weekday ?? metadata?.routine_weekday ?? (rule as any).monthWeekday,
  };

  this.tasks.push(taskData);

  // Create idle instance for routine task
  if (typeof this.ensureDayStateForCurrentDate === 'function') {
    await this.ensureDayStateForCurrentDate();
  }
  const dayState = typeof this.getCurrentDayState === 'function'
    ? this.getCurrentDayState()
    : null;
  const storedSlot = dayState?.slotOverrides?.[file.path];
  const slotKey = storedSlot || getScheduledSlotKey(metadata?.開始時刻) || 'none';
  const instance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData, dateString),
    state: 'idle',
    slotKey,
    date: dateString,
  };

  // Check hidden/deleted status using helpers (instance-aware)
  const isHidden = isInstanceHidden.call(this, instance.instanceId, file.path, dateString);
  const isDeleted = isInstanceDeleted.call(this, instance.instanceId, file.path, dateString);
  if (!isHidden && !isDeleted) {
    this.taskInstances.push(instance);
  }
}

function shouldShowRoutineTask(this: any, metadata: any, date: Date, dateString: string): boolean {
  if (!metadata) return false;
  const movedTargetDate = (metadata.target_date && metadata.target_date !== metadata.routine_start)
    ? metadata.target_date
    : undefined;
  const rule = RoutineService.parseFrontmatter(metadata);
  return RoutineService.isDue(dateString, rule, movedTargetDate);
}

function extractProjectTitle(projectField: string | undefined): string | undefined {
  if (!projectField) return undefined;
  
  // Check for [[...]] format first
  const match = projectField.match(/\[\[([^\]]+)\]\]/);
  if (match) {
    return match[1];
  }
  
  // If not in [[...]] format, return as-is (for plain text project names)
  // This handles cases like "Project - Taskchute for Local"
  return projectField;
}

function parseTimeString(timeStr: string, dateStr: string): Date | undefined {
  if (!timeStr) return undefined;
  const [hours, minutes, seconds] = timeStr.split(':').map(Number);
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, hours, minutes, seconds || 0);
}

function getScheduledSlotKey(scheduledTime: string | undefined): string | undefined {
  if (!scheduledTime) return undefined;
  const [hourStr] = scheduledTime.split(':');
  const hour = parseInt(hourStr, 10);
  
  if (hour >= 0 && hour < 8) return "0:00-8:00";
  if (hour >= 8 && hour < 12) return "8:00-12:00";
  if (hour >= 12 && hour < 16) return "12:00-16:00";
  if (hour >= 16 && hour < 24) return "16:00-0:00";
  
  return undefined;
}

function isInstanceDeleted(this: any, instanceId: string, path: string, dateString: string): boolean {
  if (typeof this.isInstanceDeleted === 'function') {
    return this.isInstanceDeleted(instanceId, path, dateString);
  }
  return false;
}

function isInstanceHidden(this: any, instanceId: string, path: string, dateString: string): boolean {
  if (typeof this.isInstanceHidden === 'function') {
    return this.isInstanceHidden(instanceId, path, dateString);
  }
  return false;
}

async function shouldShowNonRoutineTask(this: any, file: any, metadata: any, dateString: string): Promise<boolean> {
  // First check if task is deleted (only permanent path-level deletions hide the base)
  const deletedInstances = typeof this.getDeletedInstances === 'function'
    ? this.getDeletedInstances(dateString)
    : [];
  const isDeleted = deletedInstances.some(
    (d: any) => d && d.deletionType === 'permanent' && d.path === file.path,
  );
  
  if (isDeleted) {
    return false;  // Don't show deleted tasks
  }

  // Check if task has a target_date set
  if (metadata?.target_date) {
    // If target_date is set, show only on that specific date
    const shouldShow = metadata.target_date === dateString;
    return shouldShow;
  }

  // Only check file creation date if target_date is NOT set
  try {
    const stats = await this.app.vault.adapter.stat(file.path);
    if (!stats) {
      // File doesn't exist
      return false;
    }
    
    const fileCreationDate = new Date(stats.ctime || stats.mtime);
    
    // Generate date string in local timezone
    const year = fileCreationDate.getFullYear();
    const month = (fileCreationDate.getMonth() + 1).toString().padStart(2, "0");
    const day = fileCreationDate.getDate().toString().padStart(2, "0");
    const fileCreationDateString = `${year}-${month}-${day}`;
    
    
    // Show only on creation date
    if (dateString === fileCreationDateString) {
      return true;
    }
  } catch (error) {
    // Don't show on error (file might be deleted)
    return false;
  }
  
  return false;
}

async function addDuplicatedInstances(this: any, dateString: string): Promise<void> {
  try {
    const snapshot = typeof this.getDayStateSnapshot === 'function'
      ? this.getDayStateSnapshot(dateString)
      : null;
    const dayState = snapshot || (typeof this.getDayState === 'function'
      ? await this.getDayState(dateString)
      : null);
    if (!dayState || !Array.isArray(dayState.duplicatedInstances) || dayState.duplicatedInstances.length === 0) {
      return;
    }

    const records = dayState.duplicatedInstances;

    for (const rec of records) {
      const { instanceId, originalPath, slotKey } = rec || {};
      if (!instanceId || !originalPath) continue;
      // Skip if already present (e.g., completed from log)
      const exists = this.taskInstances.some((i: any) => i.instanceId === instanceId);
      if (exists) continue;

      // Try to get taskData for path
      let taskData = this.tasks.find((t: any) => t.path === originalPath);
      if (!taskData) {
        const file = this.app.vault.getAbstractFileByPath(originalPath);
        const metadata = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
        // Skip if routine is disabled
        const rule = metadata ? RoutineService.parseFrontmatter(metadata) : null;
        if (rule && rule.enabled === false) continue;
        if (file) {
          taskData = {
            file,
            frontmatter: metadata || {},
            path: originalPath,
            name: file.basename,
            title: file.basename,
            project: metadata?.project,
            projectPath: metadata?.project_path,
            projectTitle: extractProjectTitle(metadata?.project),
            isRoutine: metadata?.isRoutine === true || false,
            scheduledTime: metadata?.開始時刻,
          };
          this.tasks.push(taskData);
        } else {
          // Virtual fallback
          const base = originalPath.split('/').pop()?.replace(/\.md$/, '') || originalPath;
          taskData = {
            file: null,
            frontmatter: {},
            path: originalPath,
            name: base,
            title: base,
            isRoutine: false,
            isVirtual: true,
          };
          this.tasks.push(taskData);
        }
      }

      const instance = {
        task: taskData,
        instanceId,
        state: 'idle',
        slotKey: slotKey || 'none',
        date: dateString,
      };

      // Check deleted/hidden flags before adding
      const isDeleted = isInstanceDeleted.call(this, instance.instanceId, taskData.path, dateString);
      const isHidden = isInstanceHidden.call(this, instance.instanceId, taskData.path, dateString);
      if (!isDeleted && !isHidden) {
        this.taskInstances.push(instance);
      }
    }
  } catch (e) {
    console.error('Failed to restore duplicated instances:', e);
  }
}
