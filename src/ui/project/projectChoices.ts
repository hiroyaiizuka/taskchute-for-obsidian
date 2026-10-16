/**
 * What the project picker offers for what has been typed.
 *
 * Typing narrows the projects by name. A name no project has can be created
 * from here; that row goes right after the closest match (or first, with
 * none), so it stays near the field — on a phone the keyboard covers the
 * lower half — while Enter still picks an existing project when one is close.
 */

export interface ProjectChoiceSource {
  path: string
  /** The name shown, without the configured title prefix. */
  name: string
}

export type ProjectChoice =
  | { kind: 'project'; path: string; name: string; current: boolean }
  | { kind: 'create'; title: string }
  | { kind: 'remove' }

export function projectChoices(
  query: string,
  projects: readonly ProjectChoiceSource[],
  currentPath: string | null | undefined,
): ProjectChoice[] {
  const typed = query.trim()
  const needle = typed.toLowerCase()
  const matches: ProjectChoice[] = projects
    .filter((project) => project.name.toLowerCase().includes(needle))
    .map((project) => ({
      kind: 'project',
      path: project.path,
      name: project.name,
      current: project.path === currentPath,
    }))

  if (!typed) {
    return currentPath ? [{ kind: 'remove' }, ...matches] : matches
  }
  const exists = projects.some((project) => project.name.toLowerCase() === needle)
  if (exists) return matches
  const create: ProjectChoice = { kind: 'create', title: typed }
  return matches.length > 0 ? [matches[0], create, ...matches.slice(1)] : [create]
}
