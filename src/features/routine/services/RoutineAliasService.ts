import { Plugin, normalizePath, Notice, TFile } from 'obsidian'
import { TaskChuteSettings, PathManagerLike } from '../../../types'
import { t } from '../../../i18n'

interface PluginWithManagers extends Plugin {
  settings: TaskChuteSettings;
  pathManager: PathManagerLike;
  _notify?: (message: string) => void;
}

export class RoutineAliasService {
  private plugin: PluginWithManagers;
  private aliasCache: Record<string, string[]> = {};

  constructor(plugin: PluginWithManagers) {
    this.plugin = plugin;
  }

  getAliasFilePath(): string {
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath();
    return normalizePath(`${taskFolderPath}/routine-aliases.json`);
  }

  async loadAliases(): Promise<Record<string, string[]>> {
    if (Object.keys(this.aliasCache).length > 0) return this.aliasCache;

    const path = this.getAliasFilePath();
    try {
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await this.plugin.app.vault.read(file);
        this.aliasCache = JSON.parse(content) ?? {};
      }
    } catch {
      const message = t(
        'notices.routineAliasLoadFailed',
        'Failed to load routine alias history',
      )
      if (this.plugin._notify) {
        this.plugin._notify(message)
      } else {
        new Notice(message)
      }
    }

    return this.aliasCache;
  }

  async saveAliases(aliases: Record<string, string[]>): Promise<void> {
    try {
      const path = this.getAliasFilePath();
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      const content = JSON.stringify(aliases, null, 2);
      
      if (file instanceof TFile) {
        await this.plugin.app.vault.modify(file, content);
      } else {
        await this.plugin.app.vault.create(path, content);
      }
      
      this.aliasCache = aliases;
    } catch {
      const message = t(
        'notices.routineAliasSaveFailed',
        'Failed to save routine alias history',
      )
      if (this.plugin._notify) {
        this.plugin._notify(message)
      } else {
        new Notice(message)
      }
    }
  }

  async addAlias(newName: string, oldName: string): Promise<void> {
    const aliases = await this.loadAliases();
    
    if (!aliases[newName]) {
      aliases[newName] = [];
    }
    
    if (aliases[oldName]) {
      aliases[newName] = [...aliases[oldName], oldName];
      delete aliases[oldName];
    } else {
      aliases[newName].push(oldName);
    }
    
    aliases[newName] = [...new Set(aliases[newName])];
    await this.saveAliases(aliases);
  }

  getAliases(taskName: string): string[] {
    return this.aliasCache?.[taskName] || [];
  }

  getAllPossibleNames(taskName: string): string[] {
    const names = new Set([taskName]);
    const directAliases = this.getAliases(taskName);
    directAliases.forEach((alias) => names.add(alias));
    
    const currentName = this.findCurrentName(taskName);
    if (currentName) {
      names.add(currentName);
      const currentAliases = this.getAliases(currentName);
      currentAliases.forEach((alias) => names.add(alias));
    }
    
    return Array.from(names);
  }

  findCurrentName(oldName: string, visited: Set<string> = new Set()): string | null {
    if (!this.aliasCache) return null;
    if (visited.has(oldName)) return null;
    visited.add(oldName);
    
    for (const [current, aliases] of Object.entries(this.aliasCache)) {
      if (aliases.includes(oldName)) {
        return current;
      }
    }
    
    return null;
  }
}
