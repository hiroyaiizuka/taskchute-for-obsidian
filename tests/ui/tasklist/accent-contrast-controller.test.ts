import AccentContrastController, {
  TASK_ACCENT_PROPERTY,
} from '../../../src/ui/tasklist/AccentContrastController'
import { contrastRatio, parseRgbFunction, rgbToOklch } from '../../../src/utils/color'

/**
 * jsdom never resolves `var()`, so stand in for the browser: the probe span the
 * controller appends reports the accent, and the task list reports the
 * background.
 */
const stubComputedStyle = (options: {
  accent: string
  background: string
  transparentUntilRoot?: boolean
}): jest.SpyInstance => {
  return jest
    .spyOn(window, 'getComputedStyle')
    .mockImplementation((element: Element) => {
      const el = element as HTMLElement
      if (el.classList.contains('tc-accent-probe')) {
        const color = el.classList.contains('tc-accent-probe--background')
          ? options.background
          : options.accent
        return { color, backgroundColor: 'rgba(0, 0, 0, 0)' } as CSSStyleDeclaration
      }

      const opaque = options.transparentUntilRoot
        ? el.classList.contains('root')
        : el.classList.contains('task-list')

      return {
        color: options.accent,
        backgroundColor: opaque ? options.background : 'rgba(0, 0, 0, 0)',
      } as CSSStyleDeclaration
    })
}

const buildContainer = (): HTMLElement => {
  const container = document.createElement('div')
  container.className = 'root'
  const taskList = document.createElement('div')
  taskList.className = 'task-list'
  container.appendChild(taskList)
  document.body.appendChild(container)
  return container
}

describe('AccentContrastController', () => {
  let container: HTMLElement
  let controller: AccentContrastController

  beforeEach(() => {
    document.body.empty?.()
    document.body.innerHTML = ''
    container = buildContainer()
    controller = new AccentContrastController({ getContainer: () => container })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('publishes a readable accent when the theme accent disappears', () => {
    stubComputedStyle({ accent: 'rgb(212, 232, 79)', background: 'rgb(255, 255, 255)' })

    controller.apply()

    const published = container.style.getPropertyValue(TASK_ACCENT_PROPERTY)
    const parsed = parseRgbFunction(published)
    expect(parsed).not.toBeNull()
    expect(contrastRatio(parsed!, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(4.5)
    // Same hue as the theme accent, only darker.
    expect(rgbToOklch(parsed!).h).toBeCloseTo(rgbToOklch({ r: 212, g: 232, b: 79 }).h, 0)
  })

  test('leaves a usable theme accent alone', () => {
    stubComputedStyle({ accent: 'rgb(84, 62, 176)', background: 'rgb(255, 255, 255)' })

    controller.apply()

    expect(container.style.getPropertyValue(TASK_ACCENT_PROPERTY)).toBe('')
  })

  test('clears a previously published accent once the theme becomes readable', () => {
    container.style.setProperty(TASK_ACCENT_PROPERTY, 'rgb(1, 2, 3)')
    stubComputedStyle({ accent: 'rgb(84, 62, 176)', background: 'rgb(255, 255, 255)' })

    controller.apply()

    expect(container.style.getPropertyValue(TASK_ACCENT_PROPERTY)).toBe('')
  })

  test('lightens the accent on a dark theme background', () => {
    stubComputedStyle({ accent: 'rgb(40, 40, 120)', background: 'rgb(30, 30, 30)' })

    controller.apply()

    const parsed = parseRgbFunction(container.style.getPropertyValue(TASK_ACCENT_PROPERTY))
    expect(parsed).not.toBeNull()
    expect(contrastRatio(parsed!, { r: 30, g: 30, b: 30 })).toBeGreaterThanOrEqual(4.5)
  })

  test('walks past transparent ancestors to find the painted background', () => {
    stubComputedStyle({
      accent: 'rgb(212, 232, 79)',
      background: 'rgb(255, 255, 255)',
      transparentUntilRoot: true,
    })

    controller.apply()

    expect(container.style.getPropertyValue(TASK_ACCENT_PROPERTY)).not.toBe('')
  })

  test('does nothing when there is no container', () => {
    const detached = new AccentContrastController({ getContainer: () => null })
    expect(() => detached.apply()).not.toThrow()
  })

  test('does nothing when the colours cannot be resolved', () => {
    jest
      .spyOn(window, 'getComputedStyle')
      .mockImplementation(
        () => ({ color: 'transparent', backgroundColor: 'transparent' }) as CSSStyleDeclaration,
      )

    expect(() => controller.apply()).not.toThrow()
    expect(container.style.getPropertyValue(TASK_ACCENT_PROPERTY)).toBe('')
  })

  test('removes the probe element it appends', () => {
    stubComputedStyle({ accent: 'rgb(212, 232, 79)', background: 'rgb(255, 255, 255)' })

    controller.apply()

    expect(container.querySelectorAll('span')).toHaveLength(0)
  })
})
