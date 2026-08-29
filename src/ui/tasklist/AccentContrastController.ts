import {
  ensureReadable,
  formatRgb,
  parseRgbFunction,
  type Rgb,
} from '../../utils/color'

export const TASK_ACCENT_PROPERTY = '--tc-task-accent'

/** Matches the `.tc-accent-probe--*` modifiers declared in styles.css. */
type AccentProbeSource = 'accent' | 'background'

export interface AccentContrastHost {
  getContainer: () => HTMLElement | null | undefined
}

/**
 * Task names are painted with the theme's `--text-accent`. Some themes pick a
 * hue that is nearly invisible against `--background-primary`, so measure the
 * two colours as they are actually rendered and, when they do not read,
 * publish a hue-preserving replacement as `--tc-task-accent`.
 *
 * Nothing is published when the theme's own accent is fine, so well-behaved
 * themes keep their exact colour.
 */
export default class AccentContrastController {
  constructor(private readonly host: AccentContrastHost) {}

  apply(): void {
    const container = this.host.getContainer()
    if (!container) return

    try {
      const accent = this.resolveColor(container, 'accent')
      const background =
        this.resolveBackground(container) ?? this.resolveColor(container, 'background')
      if (!accent || !background) return

      const readable = ensureReadable(accent, background)
      // `ensureReadable` hands the accent straight back when it already reads.
      if (readable === accent) {
        container.style.removeProperty(TASK_ACCENT_PROPERTY)
        return
      }

      container.style.setProperty(TASK_ACCENT_PROPERTY, formatRgb(readable))
    } catch (error) {
      console.warn('[TaskChuteView] Failed to adjust accent contrast', error)
    }
  }

  /**
   * Let the browser resolve a theme variable for us -- computed `color` comes
   * back normalised, so we only ever have to parse `rgb()` rather than every
   * notation a theme might have written.
   */
  private resolveColor(container: HTMLElement, source: AccentProbeSource): Rgb | null {
    const view = container.ownerDocument?.defaultView
    if (!view) return null

    const probe = container.createSpan({ cls: `tc-accent-probe tc-accent-probe--${source}` })
    try {
      return parseRgbFunction(view.getComputedStyle(probe).color ?? '')
    } finally {
      probe.remove()
    }
  }

  /** Nearest painted background behind the task list. */
  private resolveBackground(container: HTMLElement): Rgb | null {
    const view = container.ownerDocument?.defaultView
    if (!view) return null

    let element: HTMLElement | null =
      container.querySelector<HTMLElement>('.task-list') ?? container
    while (element) {
      const value = view.getComputedStyle(element).backgroundColor
      // A fully transparent background means the colour comes from an ancestor.
      if (!this.isTransparent(value)) {
        const parsed = parseRgbFunction(value)
        if (parsed) return parsed
      }
      element = element.parentElement
    }

    return null
  }

  private isTransparent(value: string | null | undefined): boolean {
    if (!value) return true
    const normalized = value.trim().toLowerCase()
    if (normalized === 'transparent') return true
    const match = /^rgba?\(([^)]+)\)$/.exec(normalized)
    if (!match) return false
    const parts = match[1].split('/')
    const alpha =
      parts.length > 1
        ? parts[1].trim()
        : match[1].split(',').length === 4
          ? match[1].split(',')[3].trim()
          : '1'
    const numeric = alpha.endsWith('%')
      ? Number.parseFloat(alpha.slice(0, -1)) / 100
      : Number.parseFloat(alpha)
    return Number.isFinite(numeric) && numeric === 0
  }
}
