import { Notice, TFile, TFolder, App, TAbstractFile, EventRef } from 'obsidian';
import { t } from '../../i18n';
import type { TaskNameValidator } from '../../types';
import type { TaskChuteView } from '../../features/core/views/TaskChuteView';

export interface TaskNameAutocompleteOptions {
  view?: TaskChuteView;
  doc?: Document;
  win?: Window & typeof globalThis;
}

export type TaskNameSuggestionType = 'task' | 'project';

export interface TaskNameSuggestion {
  type: TaskNameSuggestionType;
  name: string;
  path?: string;
  targetDate?: string;
  modified?: number;
}

export interface TaskNameSelectionDetail {
  value: string;
  suggestion: TaskNameSuggestion | null;
}

interface Plugin {
  app: App;
  pathManager: {
    getTaskFolderPath(): string;
    getProjectFolderPath(): string | null;
  };
}

interface AutocompleteMatch {
  suggestion: TaskNameSuggestion;
  displayText: string;
}

export class TaskNameAutocomplete {
  private plugin: Plugin;
  private inputElement: HTMLInputElement;
  private containerElement: HTMLElement;
  private taskSuggestions: TaskNameSuggestion[] = [];
  private projectSuggestions: TaskNameSuggestion[] = [];
  private visibleMatches: AutocompleteMatch[] = [];
  private selectedIndex: number = -1;
  private suggestionsElement: HTMLElement | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private isVisible: boolean = false;
  private suppressNextShow: boolean = false;
  private fileEventRefs: EventRef[] = [];
  private view?: TaskChuteView;
  private doc: Document;
  private win: Window & typeof globalThis;

  private handleInput = (event: Event) => {
    if (this.debounceTimer) {
      this.win.clearTimeout(this.debounceTimer);
    }

    if (this.suppressNextShow) {
      if (!event.isTrusted) {
        return;
      }
      this.suppressNextShow = false;
    }

    this.debounceTimer = this.win.setTimeout(() => {
      this.showSuggestions();
    }, 100);
  };

  private handleFocus = () => {
    if (this.blurTimer) {
      this.win.clearTimeout(this.blurTimer);
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
      this.win.clearTimeout(this.blurTimer);
    }

    this.blurTimer = this.win.setTimeout(() => {
      this.blurTimer = null;

      if (
        this.suggestionsElement &&
        this.suggestionsElement.contains(this.doc.activeElement)
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

  private handleWindowScroll = (event: Event) => {
    if (!this.suggestionsElement) {
      return;
    }

    const NodeCtor: typeof Node | undefined = this.win.Node ??
      (typeof Node !== 'undefined' ? Node : undefined);
    const target = NodeCtor && event.target instanceof NodeCtor
      ? (event.target as Node)
      : null;
    if (target && this.suggestionsElement.contains(target)) {
      return;
    }

    this.hideSuggestions();
  };

  constructor(
    plugin: Plugin,
    inputElement: HTMLInputElement,
    containerElement: HTMLElement,
    options?: TaskNameAutocompleteOptions,
  ) {
    this.plugin = plugin;
    this.inputElement = inputElement;
    this.containerElement = containerElement;
    this.view = options?.view;
    this.doc = options?.doc ?? document;
    this.win = options?.win ?? window;
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
    
    const suggestions: TaskNameSuggestion[] = [];

    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') {
          const cache = this.plugin.app.metadataCache.getFileCache(child);
          const targetDate =
            typeof cache?.frontmatter?.target_date === 'string'
              ? cache.frontmatter.target_date
              : undefined;
          suggestions.push({
            type: 'task',
            name: child.basename,
            path: child.path,
            targetDate,
            modified: child.stat?.mtime ?? child.stat?.ctime ?? undefined,
          });
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };
    
    processFolder(taskFolder);
    this.taskSuggestions = suggestions;
  }

  private async loadProjectNames(): Promise<void> {
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath();
    if (!projectFolderPath) { this.projectSuggestions = []; return; }
    const projectFolder = this.plugin.app.vault.getAbstractFileByPath(projectFolderPath);
    
    if (!(projectFolder instanceof TFolder)) { this.projectSuggestions = []; return; }
    
    const suggestions: TaskNameSuggestion[] = [];
    
    const processFolder = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'md') {
          suggestions.push({
            type: 'project',
            name: child.basename,
            path: child.path,
            modified: child.stat?.mtime ?? child.stat?.ctime ?? undefined,
          });
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      }
    };
    
    processFolder(projectFolder);
    this.projectSuggestions = suggestions;
  }

  private setupEventListeners(): void {
    this.inputElement.addEventListener('input', this.handleInput);
    this.inputElement.addEventListener('focus', this.handleFocus);
    this.inputElement.addEventListener('blur', this.handleBlur);
    this.inputElement.addEventListener('keydown', this.handleKeydown);

    this.win.addEventListener('resize', this.handleWindowResize as EventListener);
    this.win.addEventListener('scroll', this.handleWindowScroll, true);
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
    const rawValue = this.inputElement.value.trim();
    const lowerValue = rawValue.toLowerCase();

    if (!lowerValue) {
      this.hideSuggestions();
      return;
    }

    const isProjectSearch = rawValue.includes('@');
    let searchTerm = lowerValue;
    let prefix = '';

    if (isProjectSearch) {
      const [beforeAt, afterAt] = rawValue.split('@');
      prefix = `${beforeAt}@`;
      searchTerm = (afterAt || '').toLowerCase();
    }

    const source = isProjectSearch
      ? this.projectSuggestions
      : this.taskSuggestions;

    const filtered = source.filter((suggestion) =>
      suggestion.name.toLowerCase().includes(searchTerm),
    );

    filtered.sort((a, b) => {
      if (isProjectSearch) {
        return a.name.localeCompare(b.name);
      }
      const aMod = a.modified ?? 0;
      const bMod = b.modified ?? 0;
      if (aMod === bMod) {
        return a.name.localeCompare(b.name);
      }
      return bMod - aMod;
    });

    const matches: AutocompleteMatch[] = filtered.slice(0, 15).map((suggestion) => ({
      suggestion,
      displayText: `${prefix}${suggestion.name}`,
    }));

    if (matches.length === 0) {
      this.hideSuggestions();
      return;
    }

    this.visibleMatches = matches;
    this.selectedIndex = -1;

    if (this.suggestionsElement) {
      this.suggestionsElement.remove();
    }
    this.suggestionsElement = this.doc.createElement('div');
    this.suggestionsElement.className = 'taskchute-autocomplete-suggestions';

    matches.forEach((match, index) => {
      const item = this.doc.createElement('div');
      item.className = 'suggestion-item';

      const title = this.doc.createElement('div');
      title.className = 'suggestion-title';

      const titleLabel = this.doc.createElement('span');
      titleLabel.textContent = match.displayText;
      title.appendChild(titleLabel);

      if (match.suggestion.type === 'project') {
        const badge = this.doc.createElement('span');
        badge.className = 'suggestion-badge';
        badge.textContent = t('addTask.suggestionTemplateBadge', 'Template');
        title.appendChild(badge);
      }

      item.appendChild(title);

      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection(
          this.suggestionsElement!.querySelectorAll('.suggestion-item'),
        );
      });

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.applySuggestionForMatch(match);
      });

      this.suggestionsElement!.appendChild(item);
    });

    const rect = this.inputElement.getBoundingClientRect();
    this.suggestionsElement.style.top = `${rect.bottom + 2}px`;
    this.suggestionsElement.style.left = `${rect.left}px`;
    this.suggestionsElement.style.width = `${rect.width}px`;

    const body = this.doc.body ?? document.body;
    body.appendChild(this.suggestionsElement);

    this.isVisible = true;
  }

  private hideSuggestions(): void {
    if (this.suggestionsElement) {
      this.suggestionsElement.remove();
      this.suggestionsElement = null;
    }
    this.isVisible = false;
    this.selectedIndex = -1;
    this.visibleMatches = [];
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
    if (this.selectedIndex < 0) return;
    const match = this.visibleMatches[this.selectedIndex];
    if (match) {
      this.applySuggestionForMatch(match);
    }
  }

  private applySuggestionForMatch(match: AutocompleteMatch): void {
    if (this.view) {
      const validator: TaskNameValidator | null =
        typeof this.view.getTaskNameValidator === 'function'
          ? this.view.getTaskNameValidator()
          : null

      if (validator && typeof validator.validate === 'function') {
        const validation = validator.validate(match.displayText);
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

    const value = match.displayText
    this.inputElement.value = value
    this.suppressNextShow = true
    this.hideSuggestions()
    // Trigger input and change events to align with spec
    this.inputElement.dispatchEvent(new Event('input', { bubbles: true }))
    this.inputElement.dispatchEvent(new Event('change', { bubbles: true }))
    // Custom event to notify selection
    this.inputElement.dispatchEvent(
      new CustomEvent<TaskNameSelectionDetail>('autocomplete-selected', {
        detail: { value, suggestion: match.suggestion },
        bubbles: true,
      }),
    )
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
      this.win.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.blurTimer) {
      this.win.clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }

    this.inputElement.removeEventListener('input', this.handleInput);
    this.inputElement.removeEventListener('focus', this.handleFocus);
    this.inputElement.removeEventListener('blur', this.handleBlur);
    this.inputElement.removeEventListener('keydown', this.handleKeydown);
    this.win.removeEventListener('resize', this.handleWindowResize as EventListener);
    this.win.removeEventListener('scroll', this.handleWindowScroll, true);

    this.fileEventRefs.forEach((ref) => {
      this.plugin.app.vault.offref(ref);
    });

    this.hideSuggestions();
  }
}
