import { Notice, TFile, TFolder, App, TAbstractFile, EventRef } from 'obsidian';
import { t } from '../../i18n';
import type { TaskNameValidator } from '../../types';
import type { TaskChuteView } from '../../features/core/views/TaskChuteView';

interface Plugin {
  app: App;
  pathManager: {
    getTaskFolderPath(): string;
    getProjectFolderPath(): string | null;
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
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private isVisible: boolean = false;
  private suppressNextShow: boolean = false;
  private fileEventRefs: EventRef[] = [];
  private view?: TaskChuteView;

  private handleInput = (event: Event) => {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.suppressNextShow) {
      if (!event.isTrusted) {
        return;
      }
      this.suppressNextShow = false;
    }

    this.debounceTimer = setTimeout(() => {
      this.showSuggestions();
    }, 100);
  };

  private handleFocus = () => {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }

    if (this.suppressNextShow) {
      this.suppressNextShow = false;
      return;
    }

    this.showSuggestions();
  };

  private handleBlur = () => {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
    }

    this.blurTimer = setTimeout(() => {
      this.blurTimer = null;

      if (
        this.suggestionsElement &&
        this.suggestionsElement.contains(document.activeElement)
      ) {
        return;
      }

      this.hideSuggestions();
    }, 200);
  };

  private handleKeydown = (e: KeyboardEvent) => {
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
  };

  private handleWindowResize = () => {
    this.hideSuggestions();
  };

  private handleWindowScroll = () => {
    this.hideSuggestions();
  };

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
    if (!projectFolderPath) { this.projectNames = []; return; }
    const projectFolder = this.plugin.app.vault.getAbstractFileByPath(projectFolderPath);
    
    if (!(projectFolder instanceof TFolder)) { this.projectNames = []; return; }
    
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
    this.inputElement.addEventListener('input', this.handleInput);
    this.inputElement.addEventListener('focus', this.handleFocus);
    this.inputElement.addEventListener('blur', this.handleBlur);
    this.inputElement.addEventListener('keydown', this.handleKeydown);

    window.addEventListener('resize', this.handleWindowResize);
    window.addEventListener('scroll', this.handleWindowScroll, true);
  }

  private setupFileEventListeners(): void {
    // Listen for file changes
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    
    const fileCreated = this.plugin.app.vault.on('create', (file: TAbstractFile) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (projectFolderPath && file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });

    const fileDeleted = this.plugin.app.vault.on('delete', (file: TAbstractFile) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath)) {
        this.loadTaskNames();
      } else if (projectFolderPath && file instanceof TFile && file.path.startsWith(projectFolderPath)) {
        this.loadProjectNames();
      }
    });

    const fileRenamed = this.plugin.app.vault.on('rename', (file: TAbstractFile) => {
      if (file instanceof TFile && 
          (file.path.startsWith(taskFolderPath) || (projectFolderPath ? file.path.startsWith(projectFolderPath) : false))) {
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

      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
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
          : null

      if (validator && typeof validator.validate === 'function') {
        const validation = validator.validate(text);
        if (!validation.isValid) {
          const message =
            typeof validator.getErrorMessage === 'function'
              ? validator.getErrorMessage(validation.invalidChars)
              : t(
                  'taskChuteView.validator.invalidChars',
                  'Task name contains invalid characters: {chars}',
                  { chars: validation.invalidChars?.join(', ') ?? '' },
                );
          new Notice(message);
          return;
        }
      }
    }

    this.inputElement.value = text
    this.suppressNextShow = true
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }

    this.inputElement.removeEventListener('input', this.handleInput);
    this.inputElement.removeEventListener('focus', this.handleFocus);
    this.inputElement.removeEventListener('blur', this.handleBlur);
    this.inputElement.removeEventListener('keydown', this.handleKeydown);
    window.removeEventListener('resize', this.handleWindowResize);
    window.removeEventListener('scroll', this.handleWindowScroll, true);

    this.fileEventRefs.forEach((ref) => {
      this.plugin.app.vault.offref(ref);
    });

    this.hideSuggestions();
  }
}
