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

    // Then, process routine tasks that haven't been executed today
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
      
      if (isRoutine && shouldShowRoutineTask.call(this, metadata, this.currentDate)) {
        await createRoutineTask.call(this, file, content, metadata, dateString);
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
  
  const taskData = {
    file: file || null,
    frontmatter: metadata || {},
    path: file?.path || `TaskChute/Task/${executions[0].taskTitle}.md`,
    name: executions[0].taskTitle,
    title: executions[0].taskTitle,
    project: metadata?.project,
    projectPath: metadata?.project_path,
    projectTitle: extractProjectTitle(metadata?.project),
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

async function createRoutineTask(this: any, file: any, content: string, metadata: any, dateString: string): Promise<void> {
  const taskData = {
    file,
    frontmatter: metadata || {},
    path: file.path,
    name: file.basename,
    title: file.basename,
    project: metadata?.project,
    projectPath: metadata?.project_path,
    projectTitle: extractProjectTitle(metadata?.project),
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

function shouldShowRoutineTask(this: any, metadata: any, date: Date): boolean {
  if (!metadata) return false;
  
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
      if (metadata.weekday !== undefined) {
        return dayOfWeek === metadata.weekday;
      }
      if (metadata.weekdays && Array.isArray(metadata.weekdays)) {
        return metadata.weekdays.includes(dayOfWeek);
      }
      return false;
      
    case 'monthly':
      if (metadata.monthly_week !== undefined && metadata.monthly_weekday !== undefined) {
        const weekOfMonth = Math.floor((date.getDate() - 1) / 7);
        return weekOfMonth === metadata.monthly_week && dayOfWeek === metadata.monthly_weekday;
      }
      return false;
      
    default:
      return true;
  }
}

function extractProjectTitle(projectField: string | undefined): string | undefined {
  if (!projectField) return undefined;
  const match = projectField.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : undefined;
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