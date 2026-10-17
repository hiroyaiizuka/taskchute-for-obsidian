/**
 * Projects shown as a kanban in Obsidian Bases (1.14+), as an alternative to
 * TaskChute's own board.
 *
 * TaskChute writes one `.base` file into the projects folder — the folder's
 * notes, a kanban grouped by `status` — and opens it. A file that is already
 * there is the user's: it is opened as it is, never rewritten.
 *
 * No column order is written. Bases hides every value a fixed order leaves
 * out, so a note whose status is spelled `in_progress` or `completed` would
 * vanish; without one it gets a column of its own, and the user orders the
 * columns by dragging them.
 */

import { normalizePath, requireApiVersion, TFile, type App } from 'obsidian'

/** Bases gained its kanban layout in this release. */
export const BASES_KANBAN_MIN_VERSION = '1.14.0'

/** The file's name in the projects folder; fixed, so a language switch does not make a second one. */
export const PROJECT_BASE_FILE_NAME = 'TaskChute Projects.base'

export type ProjectBoardViewMode = 'board' | 'bases'

export function isBasesKanbanSupported(): boolean {
  return requireApiVersion(BASES_KANBAN_MIN_VERSION)
}

export function projectBasePath(projectsFolder: string): string {
  return normalizePath(`${projectsFolder}/${PROJECT_BASE_FILE_NAME}`)
}

/** YAML single-quoted scalar: only `'` needs escaping (doubled). */
function yamlSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function projectBaseContent(projectsFolder: string, viewName: string): string {
  // A Bases formula string literal is double-quoted, with JSON-like escapes.
  const inFolder = `file.inFolder(${JSON.stringify(normalizePath(projectsFolder))})`
  return [
    'filters:',
    '  and:',
    `    - ${yamlSingleQuoted(inFolder)}`,
    `    - ${yamlSingleQuoted('file.ext == "md"')}`,
    'views:',
    '  - type: kanban',
    `    name: ${yamlSingleQuoted(viewName)}`,
    '    groupBy:',
    '      property: note.status',
    '      direction: ASC',
    '    order:',
    '      - file.name',
    '',
  ].join('\n')
}

/** The projects' `.base` file, created when missing; an existing one is left as it is. */
export async function ensureProjectBase(app: App, projectsFolder: string, viewName: string): Promise<TFile> {
  const path = projectBasePath(projectsFolder)
  const existing = app.vault.getAbstractFileByPath(path)
  if (existing instanceof TFile) return existing
  if (existing) throw new Error(`${path} exists and is not a file`)
  if (!app.vault.getAbstractFileByPath(normalizePath(projectsFolder))) {
    await app.vault.createFolder(normalizePath(projectsFolder))
  }
  return app.vault.create(path, projectBaseContent(projectsFolder, viewName))
}
