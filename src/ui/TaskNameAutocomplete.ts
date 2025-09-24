import { Notice, TFile, TFolder, App, TAbstractFile, EventRef } from 'obsidian';
import type { TaskNameValidator } from '../types';
import type { TaskChuteView } from '../views/TaskChuteView';

interface Plugin {
  app: App;
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isVisible: boolean = false;
  private fileEventRefs: EventRef[] = [];
  private view?: TaskChuteView;

  constructor(plugin: Plugin, inputElement: HTMLInputElement, containerElement: HTMLElement, view?: TaskChuteView) {
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
        // If focus moved into suggestions element, keep visible
        if (this.suggestionsElement && this.suggestionsElement.contains(document.activeElement)) return;
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

    // Window events to hide repositioned UI
    window.addEventListener('resize', () => this.hideSuggestions());
    window.addEventListener('scroll', () => this.hideSuggestions(), true);
  }

  private setupFileEventListeners(): void {
    // Listen for file changes
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    
    const fileCreated = this.plugin.app.vault.on('create', (file: TAbstractFile) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });

    const fileDeleted = this.plugin.app.vault.on('delete', (file: TAbstractFile) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });

    const fileRenamed = this.plugin.app.vault.on('rename', (file: TAbstractFile) => {
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
    if (this.suggestionsElement) {
      this.suggestionsElement.remove();
    }
    this.suggestionsElement = document.createElement('div');
    this.suggestionsElement.className = 'taskchute-autocomplete-suggestions';
    
    // Clear and populate suggestions
    matches.forEach((match, index) => {
      const item = document.createElement('div')
      item.className = 'suggestion-item'
      item.textContent = prefix + match

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index
        this.updateSelection(this.suggestionsElement!.querySelectorAll('.suggestion-item'))
      })

      item.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.applySuggestionFromText(prefix + match)
      })

      this.suggestionsElement!.appendChild(item)
    })
    
    // Position suggestions
    const rect = this.inputElement.getBoundingClientRect();
    this.suggestionsElement.style.top = `${rect.bottom + 2}px`;
    this.suggestionsElement.style.left = `${rect.left}px`;
    this.suggestionsElement.style.width = `${rect.width}px`;

    // Append to body so absolute coordinates match viewport
    document.body.appendChild(this.suggestionsElement)

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
        item.classList.add('suggestion-item-selected')
      } else {
        item.classList.remove('suggestion-item-selected')
      }
    });
  }

  private applySuggestion(): void {
    if (!this.suggestionsElement || this.selectedIndex < 0) return;
    
    const items = this.suggestionsElement.querySelectorAll('.suggestion-item');
    const selectedItem = items[this.selectedIndex] as HTMLElement;

    if (selectedItem) {
      const text = selectedItem.textContent || ''
      this.applySuggestionFromText(text)
    }
  }

  private applySuggestionFromText(text: string): void {
    if (this.view) {
      const validator: TaskNameValidator | null =
        typeof this.view.getTaskNameValidator === 'function'
          ? this.view.getTaskNameValidator()
          : (this.view.TaskNameValidator ?? null);

      if (validator && typeof validator.validate === 'function') {
        const validation = validator.validate(text);
        if (!validation.isValid) {
          const message =
            typeof validator.getErrorMessage === 'function'
              ? validator.getErrorMessage(validation.invalidChars)
              : 'このタスク名には使用できない文字が含まれています';
          new Notice(message);
          return;
        }
      }
    }

    this.inputElement.value = text
    this.hideSuggestions()
    // Trigger input and change events to align with spec
    this.inputElement.dispatchEvent(new Event('input', { bubbles: true }))
    this.inputElement.dispatchEvent(new Event('change', { bubbles: true }))
    // Custom event to notify selection
    this.inputElement.dispatchEvent(new CustomEvent('autocomplete-selected', {
      detail: { taskName: text },
      bubbles: true,
    }))
    // Keep focus on input
    this.inputElement.focus()
  }

  public isSuggestionsVisible(): boolean {
    return this.isVisible;
  }

  public hasActiveSelection(): boolean {
    return this.selectedIndex >= 0;
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
