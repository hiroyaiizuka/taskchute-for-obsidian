import type { SectionModule } from "../types"
import { logBackupSection } from "./logBackup"
import { projectCandidateSection } from "./projectCandidate"
import { reviewTemplateSection } from "./reviewTemplate"
import { storageSection } from "./storage"
import { versionSection } from "./version"

export { logBackupSection, projectCandidateSection, reviewTemplateSection, storageSection, versionSection }

/**
 * The sections that always appear, in display order. The advanced and Pro
 * sections are supplied by the tab because they carry state it owns.
 */
export function everydaySections(): SectionModule[] {
  return [
    storageSection,
    logBackupSection,
    reviewTemplateSection,
    projectCandidateSection,
  ]
}

/** Last, after everything the advanced and Pro sections add. */
export function trailingSections(): SectionModule[] {
  return [versionSection()]
}
