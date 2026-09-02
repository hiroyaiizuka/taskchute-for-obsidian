import { t } from '../../../i18n'

export interface RecipeEmptyStateOptions {
  onCreate: () => void
  title?: string
  message?: string
  buttonText?: string
}

export function renderRecipeEmptyState(container: HTMLElement, options: RecipeEmptyStateOptions): void {
  const empty = container.createDiv( { cls: 'recipe-empty-create-state' })
  empty.createDiv( {
    cls: 'recipe-empty-create-title',
    text: options.title ?? t('recipes.empty.title', 'No recipes yet.'),
  })
  empty.createDiv( {
    cls: 'recipe-empty-create-message',
    text: options.message ?? t('recipes.empty.message', 'Create one in this modal?'),
  })
  const createButton = empty.createEl('button', {
    cls: 'form-button create recipe-empty-create-button',
    text: options.buttonText ?? t('recipes.empty.createButton', 'Create recipe'),
    attr: { type: 'button' },
  })
  createButton.addEventListener('click', options.onCreate)
}
