import type { TaskInstance } from '../../../types'
import { appendRecipeFileIcon } from './RecipeFileIcon'

export interface RecipeProgressSummary {
  total: number
  checked: number
}

export interface RecipeIconRendererOptions {
  tv: (key: string, fallback: string, vars?: Record<string, string | number>) => string
  getSummary: (inst: TaskInstance) => Promise<RecipeProgressSummary | null>
  onClick: (inst: TaskInstance, anchor: HTMLElement) => void
}

export class RecipeIconRenderer {
  constructor(private readonly options: RecipeIconRendererOptions) {}

  render(container: HTMLElement, inst: TaskInstance): void {
    if (!inst.task.recipePath) return
    const iconContainer = container.createSpan( {
      cls: 'recipe-task-badge',
      attr: {
        title: this.options.tv('recipes.openRecipe', 'Open recipe'),
        role: 'button',
        tabindex: '0',
        'aria-label': this.options.tv('recipes.openRecipe', 'Open recipe'),
      },
    })
    appendRecipeFileIcon(iconContainer)
    const open = (event: Event) => {
      event.stopPropagation()
      this.options.onClick(inst, iconContainer)
    }
    iconContainer.addEventListener('click', open)
    iconContainer.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      open(event)
    })
    void this.options.getSummary(inst).then((summary) => {
      if (!iconContainer.isConnected) return
      if (!summary) {
        iconContainer.remove()
        return
      }
    }).catch((error) => {
      console.warn('[RecipeIconRenderer] Failed to render recipe badge', error)
      iconContainer.remove()
    })
  }
}
