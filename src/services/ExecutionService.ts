import { TFile } from 'obsidian';
import TaskChutePlugin from '../main';

export interface TaskExecution {
  taskTitle: string;
  taskPath: string;
  startTime: string;
  stopTime: string;
  slotKey: string;
  instanceId?: string;
}

export class ExecutionService {
  constructor(private plugin: TaskChutePlugin) {}

  /**
   * Load today's task executions from log file
   */
  async loadTodayExecutions(dateString: string): Promise<TaskExecution[]> {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath();
      const [year, month] = dateString.split('-');
      const monthString = `${year}-${month}`;
      const logPath = `${logDataPath}/${monthString}-tasks.json`;
      
      const logFile = this.app.vault.getAbstractFileByPath(logPath);
      if (!logFile || !(logFile instanceof TFile)) {
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
        slotKey: exec.slotKey || this.calculateSlotKey(exec.startTime),
        instanceId: exec.instanceId,
      }));
    } catch (error) {
      console.error('Failed to load today executions:', error);
      return [];
    }
  }

  /**
   * Calculate time slot key based on time string
   */
  private calculateSlotKey(timeStr: string): string {
    if (!timeStr) return "none";
    
    const [hourStr] = timeStr.split(':');
    const hour = parseInt(hourStr, 10);
    
    if (hour >= 0 && hour < 8) return "0:00-8:00";
    if (hour >= 8 && hour < 12) return "8:00-12:00";
    if (hour >= 12 && hour < 16) return "12:00-16:00";
    if (hour >= 16 && hour < 24) return "16:00-0:00";
    
    return "none";
  }

  private get app() {
    return this.plugin.app;
  }
}