import type { App } from 'obsidian'

import { listFilesInFolder } from '../../../utils/vaultFiles'

/**
 * Collect working-directory candidates from every AI task note in the
 * configured task folder.
 *
 * This deliberately delegates discovery to listFilesInFolder so the search
 * stays inside the configured folder tree. In particular, it must not use
 * Vault#getMarkdownFiles or Vault#getFiles, which would enumerate unrelated
 * user notes across the whole vault.
 */
export function collectAiTaskWorkingDirectoryCandidates(
  app: Pick<App, 'vault' | 'metadataCache'>,
  taskFolderPath: string,
): string[] {
  const files = listFilesInFolder(app, taskFolderPath, {
    markdownOnly: true,
    recursive: true,
  })
  const candidates: string[] = []

  for (const file of files) {
    let frontmatter: Record<string, unknown> | undefined
    try {
      frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
        | Record<string, unknown>
        | undefined
    } catch {
      // One stale/broken cache entry must not hide candidates from later files.
      continue
    }

    if (frontmatter?.['ai_task'] !== true) continue

    const value = frontmatter['ai_task_cwd']
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) candidates.push(trimmed)
  }

  return candidates
}
