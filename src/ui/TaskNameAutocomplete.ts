import { TFile, TFolder } from 'obsidian';

interface Plugin {
  app: any;
  pathManager: {
    getTaskFolderPath(): string;
    getProjectFolderPath(): string;
  };
}

export class TaskNameAutocomplete {
  private plugin: Plugin;
  private inputElement: HTMLInputElement;
  private containerElement: HTMLElement;
  private taskNames: string[] = [];
  private projectNames: string[] = [];
  private selectedIndex: number = -1;
  private suggestionsElement: HTMLElement | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isVisible: boolean = false;
  private fileEventRefs: any[] = [];
  private view: any;

  constructor(plugin: Plugin, inputElement: HTMLInputElement, containerElement: HTMLElement, view?: any) {
    this.plugin = plugin;
    this.inputElement = inputElement;
    this.containerElement = containerElement;
    this.view = view;
  }

  async initialize(): Promise<void> {
    await this.loadTaskNames();
    await this.loadProjectNames();
    this.setupEventListeners();
    this.setupFileEventListeners();
  }

  private async loadTaskNames(): Promise<void> {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const taskFolder = this.plugin.app.vault.getAbstractFileByPath(taskFolderPath);
    
    if (!(taskFolder instanceof TFolder)) return;
    
    const taskNames = new Set<string>();
    
    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') {
          const name = child.basename;
          taskNames.add(name);
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };
    
    processFolder(taskFolder);
    this.taskNames = Array.from(taskNames).sort();
  }

  private async loadProjectNames(): Promise<void> {
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    const projectFolder = this.plugin.app.vault.getAbstractFileByPath(projectFolderPath);
    
    if (!(projectFolder instanceof TFolder)) return;
    
    const projectNames = new Set<string>();
    
    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') {
          const name = child.basename;
          projectNames.add(name);
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };
    
    processFolder(projectFolder);
    this.projectNames = Array.from(projectNames).sort();
  }

  private setupEventListeners(): void {
    // Input event
    this.inputElement.addEventListener('input', () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      
      this.debounceTimer = setTimeout(() => {
        this.showSuggestions();
      }, 100);
    });
    
    // Focus event
    this.inputElement.addEventListener('focus', () => {
      this.showSuggestions();
    });
    
    // Blur event
    this.inputElement.addEventListener('blur', () => {
      // Delay hide to allow click on suggestions
      setTimeout(() => {
        this.hideSuggestions();
      }, 200);
    });
    
    // Keyboard navigation
    this.inputElement.addEventListener('keydown', (e) => {
      if (!this.isVisible) return;
      
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.selectNext();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.selectPrevious();
          break;
        case 'Enter':
          if (this.selectedIndex >= 0) {
            e.preventDefault();
            this.applySuggestion();
          }
          break;
        case 'Escape':
          this.hideSuggestions();
          break;
        case 'Tab':
          if (this.selectedIndex >= 0) {
            e.preventDefault();
            this.applySuggestion();
          }
          break;
      }
    });
  }

  private setupFileEventListeners(): void {
    // Listen for file changes
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    
    const fileCreated = this.plugin.app.vault.on('create', (file: any) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });
    
    const fileDeleted = this.plugin.app.vault.on('delete', (file: any) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });
    
    const fileRenamed = this.plugin.app.vault.on('rename', (file: any) => {
      if (file instanceof TFile && 
          (file.path.startsWith(taskFolderPath) || file.path.startsWith(projectFolderPath))) {
        this.loadTaskNames();
        this.loadProjectNames();
      }
    });
    
    this.fileEventRefs.push(fileCreated, fileDeleted, fileRenamed);
  }

  private showSuggestions(): void {
    const inputValue = this.inputElement.value.trim().toLowerCase();
    
    if (!inputValue) {
      this.hideSuggestions();
      return;
    }
    
    // Check if input contains project marker
    const isProjectSearch = inputValue.includes('@');
    let searchTerm = inputValue;
    let prefix = '';
    
    if (isProjectSearch) {
      const parts = inputValue.split('@');
      searchTerm = parts[1] || '';
      prefix = parts[0] + '@';
    }
    
    // Get matching suggestions
    const source = isProjectSearch ? this.projectNames : this.taskNames;
    const matches = source.filter(name => 
      name.toLowerCase().includes(searchTerm)
    ).slice(0, 10);
    
    if (matches.length === 0) {
      this.hideSuggestions();
      return;
    }
    
    // Create or update suggestions element
    if (!this.suggestionsElement) {
      this.suggestionsElement = document.createElement('div');
      this.suggestionsElement.className = 'task-autocomplete-suggestions';
      this.containerElement.appendChild(this.suggestionsElement);
    }
    
    // Clear and populate suggestions
    this.suggestionsElement.empty();
    
    matches.forEach((match, index) => {
      const item = this.suggestionsElement!.createEl('div', {
        cls: 'suggestion-item',
        text: prefix + match
      });
      
      if (index === this.selectedIndex) {
        item.addClass('selected');
      }
      
      item.onclick = () => {
        this.inputElement.value = prefix + match;
        this.hideSuggestions();
        this.inputElement.focus();
        
        // Trigger input event
        const event = new Event('input', { bubbles: true });
        this.inputElement.dispatchEvent(event);
      };
    });
    
    // Position suggestions
    const rect = this.inputElement.getBoundingClientRect();
    this.suggestionsElement.style.top = `${rect.bottom}px`;
    this.suggestionsElement.style.left = `${rect.left}px`;
    this.suggestionsElement.style.width = `${rect.width}px`;
    
    this.isVisible = true;
  }

  private hideSuggestions(): void {
    if (this.suggestionsElement) {
      this.suggestionsElement.remove();
      this.suggestionsElement = null;
    }
    this.isVisible = false;
    this.selectedIndex = -1;
  }

  private selectNext(): void {
    if (!this.suggestionsElement) return;
    
    const items = this.suggestionsElement.querySelectorAll('.suggestion-item');
    if (items.length === 0) return;
    
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
    this.updateSelection(items);
  }

  private selectPrevious(): void {
    if (!this.suggestionsElement) return;
    
    const items = this.suggestionsElement.querySelectorAll('.suggestion-item');
    if (items.length === 0) return;
    
    this.selectedIndex = this.selectedIndex <= 0 ? items.length - 1 : this.selectedIndex - 1;
    this.updateSelection(items);
  }

  private updateSelection(items: NodeListOf<Element>): void {
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
      } else {
        item.removeClass('selected');
      }
    });
  }

  private applySuggestion(): void {
    if (!this.suggestionsElement || this.selectedIndex < 0) return;
    
    const items = this.suggestionsElement.querySelectorAll('.suggestion-item');
    const selectedItem = items[this.selectedIndex] as HTMLElement;
    
    if (selectedItem) {
      this.inputElement.value = selectedItem.textContent || '';
      this.hideSuggestions();
      
      // Trigger input event
      const event = new Event('input', { bubbles: true });
      this.inputElement.dispatchEvent(event);
    }
  }

  destroy(): void {
    // Clean up event listeners
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.fileEventRefs.forEach(ref => {
      this.plugin.app.vault.offref(ref);
    });
    
    this.hideSuggestions();
  }
}