import { TFile, Notice } from 'obsidian';
import { HeatmapData } from '../types';

interface PluginWithPath {
  app: any;
  pathManager: {
    getLogDataPath(): string;
    getLogYearPath(year: number): string;
    ensureYearFolder(year: number): Promise<string>;
  };
}

export class LogView {
  private plugin: PluginWithPath;
  private container: HTMLElement;
  private currentYear: number;
  private heatmapData: HeatmapData | null = null;
  private dataCache: { [year: number]: HeatmapData } = {};

  constructor(plugin: PluginWithPath, container: HTMLElement) {
    this.plugin = plugin;
    this.container = container;
    this.currentYear = new Date().getFullYear();
  }

  async render(): Promise<void> {
    // Clear container
    this.container.empty();

    // Create header
    this.createHeader();

    // Show loading
    const loadingContainer = this.container.createEl('div', {
      cls: 'heatmap-loading',
      text: 'データを読み込み中...'
    });

    try {
      // Force regeneration on initial render for current year
      if (this.currentYear === new Date().getFullYear()) {
        // Clear cache
        delete this.dataCache[this.currentYear];
        
        // Delete existing yearly file to force regeneration
        try {
          const yearPath = this.plugin.pathManager.getLogYearPath(this.currentYear);
          const yearFile = this.plugin.app.vault.getAbstractFileByPath(
            `${yearPath}/yearly-heatmap.json`
          );
          if (yearFile instanceof TFile) {
            await this.plugin.app.vault.delete(yearFile);
          }
        } catch (error) {
          // File might not exist, ignore
        }
      }

      // Load or generate data
      this.heatmapData = await this.loadYearlyData(this.currentYear);
      
      // Remove loading
      loadingContainer.remove();
      
      // Render heatmap
      this.renderHeatmap();
    } catch (error) {
      loadingContainer.textContent = 'データの読み込みに失敗しました';
      console.error('Failed to load heatmap data:', error);
    }
  }

  private createHeader(): void {
    const header = this.container.createEl('div', { cls: 'heatmap-header' });
    
    // Year navigation
    const yearNav = header.createEl('div', { cls: 'year-navigation' });
    
    const prevButton = yearNav.createEl('button', {
      text: '◀',
      cls: 'year-nav-button'
    });
    prevButton.onclick = () => this.changeYear(this.currentYear - 1);
    
    const yearLabel = yearNav.createEl('span', {
      text: `${this.currentYear}年`,
      cls: 'year-label'
    });
    
    const nextButton = yearNav.createEl('button', {
      text: '▶',
      cls: 'year-nav-button'
    });
    nextButton.onclick = () => this.changeYear(this.currentYear + 1);
    
    // Stats
    const stats = header.createEl('div', { cls: 'heatmap-stats' });
    if (this.heatmapData) {
      const totalDays = Object.keys(this.heatmapData).length;
      const totalMinutes = Object.values(this.heatmapData).reduce(
        (sum, day) => sum + (day.totalMinutes || 0), 0
      );
      const totalTasks = Object.values(this.heatmapData).reduce(
        (sum, day) => sum + (day.totalTasks || 0), 0
      );
      
      stats.createEl('div', {
        text: `${totalDays}日 / ${totalTasks}タスク / ${Math.round(totalMinutes / 60)}時間`,
        cls: 'stats-text'
      });
    }
  }

  private async loadYearlyData(year: number): Promise<HeatmapData> {
    // Check cache first
    if (this.dataCache[year]) {
      return this.dataCache[year];
    }

    // Ensure year folder exists
    await this.plugin.pathManager.ensureYearFolder(year);
    
    const yearPath = this.plugin.pathManager.getLogYearPath(year);
    const heatmapPath = `${yearPath}/yearly-heatmap.json`;
    
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath);
      if (file instanceof TFile) {
        const content = await this.plugin.app.vault.read(file);
        const data = JSON.parse(content);
        this.dataCache[year] = data;
        return data;
      }
    } catch (error) {
      console.log('Generating new heatmap data for year:', year);
    }

    // Generate new data
    const data = await this.generateYearlyHeatmap(year);
    this.dataCache[year] = data;
    
    // Save to file
    try {
      await this.plugin.app.vault.create(
        heatmapPath,
        JSON.stringify(data, null, 2)
      );
    } catch (error) {
      if (error.message?.includes('File already exists')) {
        const file = this.plugin.app.vault.getAbstractFileByPath(heatmapPath);
        if (file instanceof TFile) {
          await this.plugin.app.vault.modify(file, JSON.stringify(data, null, 2));
        }
      }
    }
    
    return data;
  }

  private async generateYearlyHeatmap(year: number): Promise<HeatmapData> {
    const heatmapData: HeatmapData = {};
    const logPath = this.plugin.pathManager.getLogDataPath();
    
    // Process each month
    for (let month = 1; month <= 12; month++) {
      const monthStr = String(month).padStart(2, '0');
      const monthFile = `${logPath}/${year}-${monthStr}-tasks.json`;
      
      try {
        const file = this.plugin.app.vault.getAbstractFileByPath(monthFile);
        if (file instanceof TFile) {
          const content = await this.plugin.app.vault.read(file);
          const monthData = JSON.parse(content);
          
          // Process each day
          for (const [date, tasks] of Object.entries(monthData)) {
            let totalMinutes = 0;
            let totalTasks = 0;
            
            for (const task of Object.values(tasks as any)) {
              if (task.actualMinutes) {
                totalMinutes += task.actualMinutes;
              }
              if (task.status === 'done' || task.status === 'completed') {
                totalTasks++;
              }
            }
            
            heatmapData[date] = {
              totalMinutes,
              totalTasks,
              procrastination: 0 // Calculate based on scheduled vs actual
            };
          }
        }
      } catch (error) {
        // Month file doesn't exist, skip
      }
    }
    
    return heatmapData;
  }

  private renderHeatmap(): void {
    if (!this.heatmapData) return;
    
    const heatmapContainer = this.container.createEl('div', {
      cls: 'heatmap-container'
    });
    
    // Create month labels
    const monthsContainer = heatmapContainer.createEl('div', {
      cls: 'heatmap-months'
    });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    months.forEach(month => {
      monthsContainer.createEl('div', {
        text: month,
        cls: 'month-label'
      });
    });
    
    // Create day grid
    const gridContainer = heatmapContainer.createEl('div', {
      cls: 'heatmap-grid'
    });
    
    // Generate all days of the year
    const startDate = new Date(this.currentYear, 0, 1);
    const endDate = new Date(this.currentYear, 11, 31);
    
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = this.formatDate(d);
      const dayData = this.heatmapData[dateStr];
      
      const dayEl = gridContainer.createEl('div', {
        cls: 'heatmap-day',
        attr: {
          'data-date': dateStr,
          'data-minutes': dayData?.totalMinutes || 0,
          'data-tasks': dayData?.totalTasks || 0
        }
      });
      
      // Set intensity based on activity
      if (dayData) {
        const intensity = this.calculateIntensity(dayData.totalMinutes);
        dayEl.addClass(`intensity-${intensity}`);
        
        // Special animation for zero procrastination days
        if (dayData.procrastination === 0 && dayData.totalTasks > 0) {
          dayEl.addClass('zero-procrastination');
        }
      }
      
      // Click handler
      dayEl.onclick = () => {
        this.navigateToDate(dateStr);
      };
      
      // Tooltip
      dayEl.title = `${dateStr}\n${dayData?.totalTasks || 0}タスク\n${dayData?.totalMinutes || 0}分`;
    }
  }

  private calculateIntensity(minutes: number): number {
    if (minutes === 0) return 0;
    if (minutes < 60) return 1;
    if (minutes < 180) return 2;
    if (minutes < 360) return 3;
    return 4;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async changeYear(year: number): Promise<void> {
    this.currentYear = year;
    await this.render();
  }

  private navigateToDate(dateStr: string): void {
    // Trigger navigation in main view
    const event = new CustomEvent('taskchute-navigate-date', {
      detail: { date: dateStr }
    });
    window.dispatchEvent(event);
    
    new Notice(`${dateStr}に移動しました`);
  }

  destroy(): void {
    this.container.empty();
    this.dataCache = {};
    this.heatmapData = null;
  }
}