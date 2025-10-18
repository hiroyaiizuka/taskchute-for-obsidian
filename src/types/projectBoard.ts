import type { TFile } from 'obsidian'

export type ProjectBoardStatus = 'todo' | 'in-progress' | 'done'

export interface ProjectBoardItem {
  file: TFile
  path: string
  basename: string
  title: string
  displayTitle: string
  status: ProjectBoardStatus
  order?: number | null
  created?: string
  updated?: string
  completed?: string
  notes?: string
  frontmatter: Record<string, unknown>
}

export interface ProjectBoardState {
  hiddenStatuses: ProjectBoardStatus[]
  updatedAt: string
}

export class ProjectBoardError extends Error {}

export class ProjectFolderUnsetError extends ProjectBoardError {
  constructor(message = 'Project folder is not configured') {
    super(message)
    this.name = 'ProjectFolderUnsetError'
  }
}
