// Refactored loadTasks implementation with proper filtering

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

    // Track processed task names to avoid duplicates
    const processedTaskNames = new Set<string>();
    const processedFilePaths = new Set<string>();

    // First, process tasks from execution history
    for (const exec of todayExecutions) {
      if (!processedTaskNames.has(exec.taskTitle)) {
        processedTaskNames.add(exec.taskTitle);
        
        // Find the task file
        const taskFile = taskFiles.find((f: any) => f.basename === exec.taskTitle);
        if (taskFile) {
          processedFilePaths.add(taskFile.path);
        }
        
        // Get all executions for this task
        const taskExecutions = todayExecutions.filter(
          (e: any) => e.taskTitle === exec.taskTitle
        );
        
        // Create task from execution
        await createTaskFromExecutions.call(this, taskExecutions, taskFile, dateString);
      }
    }

    // Then, process tasks that haven't been executed today (routine and non-routine)
    for (const file of taskFiles) {
      if (processedFilePaths.has(file.path)) continue;
      
      const content = await this.app.vault.read(file);
      const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
      
      // Check if it's a task file
      if (!content.includes("#task") && !metadata?.estimatedMinutes) {
        continue;
      }
      
      // Check if it's a routine task
      const isRoutine = metadata?.isRoutine === true || content.includes("#routine");
      
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

async function createTaskFromExecutions(this: any, executions: any[], file: any, dateString: string): Promise<void> {
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
  
  const taskData = {
    file: file || null,
    frontmatter: metadata || {},
    path: file?.path || `TaskChute/Task/${executions[0].taskTitle}.md`,
    name: executions[0].taskTitle,
    title: executions[0].taskTitle,
    project: metadata?.project,
    projectPath: projectPath,
    projectTitle: projectTitle,
    isRoutine: metadata?.isRoutine === true || false,
    routineType: metadata?.routine_type,
    scheduledTime: metadata?.開始時刻,
    isVirtual: !file,
  };

  this.tasks.push(taskData);

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
    }
  }
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
  const instance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData.path),
    state: 'idle',
    slotKey: getScheduledSlotKey(metadata?.開始時刻) || 'none',
    date: dateString,
  };

  // Check if deleted - check by path only for non-routine tasks
  const deletedKey = `taskchute-deleted-instances-${dateString}`;
  const deletedInstances = JSON.parse(localStorage.getItem(deletedKey) || '[]');
  const isDeleted = deletedInstances.some((d: any) => 
    d.path === file.path
  );

  if (!isDeleted) {
    this.taskInstances.push(instance);
  }
}

async function createRoutineTask(this: any, file: any, content: string, metadata: any, dateString: string): Promise<void> {
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
    routineType: metadata?.routine_type || 'daily',
    scheduledTime: metadata?.開始時刻,
    weekday: metadata?.weekday,
    weekdays: metadata?.weekdays,
    monthlyWeek: metadata?.monthly_week,
    monthlyWeekday: metadata?.monthly_weekday,
  };

  this.tasks.push(taskData);

  // Create idle instance for routine task
  const instance = {
    task: taskData,
    instanceId: this.generateInstanceId(taskData.path),
    state: 'idle',
    slotKey: getScheduledSlotKey(metadata?.開始時刻) || 'none',
    date: dateString,
  };

  // Check if hidden for today
  const hiddenKey = `taskchute-hidden-routines-${dateString}`;
  const hiddenRoutines = JSON.parse(localStorage.getItem(hiddenKey) || '[]');
  const isHidden = hiddenRoutines.some((h: any) => 
    (typeof h === 'string' ? h === file.path : h.path === file.path)
  );

  // Check if deleted
  const deletedKey = `taskchute-deleted-instances-${dateString}`;
  const deletedInstances = JSON.parse(localStorage.getItem(deletedKey) || '[]');
  const isDeleted = deletedInstances.some((d: any) => 
    d.path === file.path && (!d.instanceId || d.instanceId === instance.instanceId)
  );

  if (!isHidden && !isDeleted) {
    this.taskInstances.push(instance);
  }
}

function shouldShowRoutineTask(this: any, metadata: any, date: Date, dateString: string): boolean {
  if (!metadata) return false;
  
  // Check if this routine task has been moved to a different date
  // If target_date exists and differs from routine_start, it's a moved routine task
  const hasMovedTargetDate = metadata.target_date && 
    metadata.target_date !== metadata.routine_start;
  
  if (hasMovedTargetDate) {
    // Show only on the target date
    return dateString === metadata.target_date;
  }
  
  const routineType = metadata.routine_type || 'daily';
  const dayOfWeek = date.getDay(); // 0 = Sunday
  
  switch (routineType) {
    case 'daily':
      return true;
      
    case 'weekdays':
      return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
      
    case 'weekends':
      return dayOfWeek === 0 || dayOfWeek === 6; // Saturday and Sunday
      
    case 'weekly':
    case 'custom':  // custom is treated same as weekly
      if (metadata.weekday !== undefined) {
        return dayOfWeek === metadata.weekday;
      }
      if (metadata.weekdays && Array.isArray(metadata.weekdays)) {
        return metadata.weekdays.includes(dayOfWeek);
      }
      return false;
      
    case 'monthly':
      if (metadata.monthly_week !== undefined && metadata.monthly_weekday !== undefined) {
        // 指定された曜日と一致しない場合は表示しない
        if (dayOfWeek !== metadata.monthly_weekday) {
          return false;
        }
        
        // "last"週の処理
        if (metadata.monthly_week === 'last') {
          // 次週の同じ曜日が翌月なら、今週が最終週
          const nextWeek = new Date(date);
          nextWeek.setDate(date.getDate() + 7);
          return nextWeek.getMonth() !== date.getMonth();
        }
        
        // その月で何回目の該当曜日かを計算（1ベース）
        const weekOfMonth = Math.floor((date.getDate() - 1) / 7) + 1;
        return weekOfMonth === metadata.monthly_week;
      }
      return false;
      
    default:
      return true;
  }
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
  const deletedKey = `taskchute-deleted-instances-${dateString}`;
  const deletedInstances = JSON.parse(localStorage.getItem(deletedKey) || '[]');
  return deletedInstances.some((d: any) => 
    (d.instanceId === instanceId) || (d.path === path && !d.instanceId)
  );
}

function isInstanceHidden(this: any, instanceId: string, path: string, dateString: string): boolean {
  const hiddenKey = `taskchute-hidden-routines-${dateString}`;
  const hiddenRoutines = JSON.parse(localStorage.getItem(hiddenKey) || '[]');
  return hiddenRoutines.some((h: any) => 
    (typeof h === 'string' ? h === path : (h.instanceId === instanceId || h.path === path))
  );
}

async function shouldShowNonRoutineTask(this: any, file: any, metadata: any, dateString: string): Promise<boolean> {
  // First check if task is deleted
  const deletedKey = `taskchute-deleted-instances-${dateString}`;
  const deletedInstances = JSON.parse(localStorage.getItem(deletedKey) || '[]');
  const isDeleted = deletedInstances.some((d: any) => 
    d.path === file.path
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
