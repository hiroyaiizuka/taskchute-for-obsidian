export const VAULT_ROOT_PATH = '/'

export function getPathSuggestParentFolder(query: string): string {
  const slashIndex = query.lastIndexOf('/')
  if (slashIndex < 0) return VAULT_ROOT_PATH

  const parentFolder = query.slice(0, slashIndex)
  return parentFolder.length > 0 ? parentFolder : VAULT_ROOT_PATH
}
