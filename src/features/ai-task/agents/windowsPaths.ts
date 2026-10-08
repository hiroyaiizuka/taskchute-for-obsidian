/** Joins a Windows root and parts with `\`; '' when the root is missing, so the candidate is skipped. */
export function windowsJoin(root: string | undefined, ...parts: string[]): string {
  if (root === undefined || root.length === 0) return ''
  return [root, ...parts]
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/u, '')
        : part.replace(/^[\\/]+|[\\/]+$/gu, ''),
    )
    .join('\\')
}
