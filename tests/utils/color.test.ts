import {
  contrastRatio,
  ensureReadable,
  formatRgb,
  oklchToRgb,
  parseRgbFunction,
  relativeLuminance,
  rgbToOklch,
  type Rgb,
} from '../../src/utils/color'

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }
const DARK_BACKGROUND: Rgb = { r: 30, g: 30, b: 30 }
/** The lime accent from the unreadable screenshot. */
const LIME: Rgb = { r: 212, g: 232, b: 79 }

const hueDelta = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

describe('parseRgbFunction', () => {
  test('parses the legacy comma syntax', () => {
    expect(parseRgbFunction('rgb(212, 232, 79)')).toEqual(LIME)
  })

  test('parses rgba and ignores alpha', () => {
    expect(parseRgbFunction('rgba(0, 0, 0, 0.5)')).toEqual(BLACK)
  })

  test('parses the modern space syntax with a slashed alpha', () => {
    expect(parseRgbFunction('rgb(255 255 255 / 20%)')).toEqual(WHITE)
  })

  test('returns null for values it cannot read', () => {
    expect(parseRgbFunction('transparent')).toBeNull()
    expect(parseRgbFunction('#d4e84f')).toBeNull()
    expect(parseRgbFunction('')).toBeNull()
  })
})

describe('contrastRatio', () => {
  test('black on white is the maximum ratio', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5)
  })

  test('a colour against itself is 1', () => {
    expect(contrastRatio(LIME, LIME)).toBeCloseTo(1, 5)
  })

  test('is symmetric', () => {
    expect(contrastRatio(LIME, WHITE)).toBeCloseTo(contrastRatio(WHITE, LIME), 10)
  })

  test('the screenshot colour is genuinely unreadable on white', () => {
    expect(contrastRatio(LIME, WHITE)).toBeLessThan(2)
  })
})

describe('relativeLuminance', () => {
  test('spans 0 to 1', () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 10)
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10)
  })
})

describe('OKLCH conversion', () => {
  test('round-trips within a quantisation step', () => {
    const samples: Rgb[] = [
      LIME,
      { r: 127, g: 109, b: 242 },
      { r: 18, g: 200, b: 140 },
      { r: 200, g: 40, b: 40 },
      WHITE,
      BLACK,
    ]

    for (const sample of samples) {
      const restored = oklchToRgb(rgbToOklch(sample))
      expect(Math.abs(restored.r - sample.r)).toBeLessThan(1)
      expect(Math.abs(restored.g - sample.g)).toBeLessThan(1)
      expect(Math.abs(restored.b - sample.b)).toBeLessThan(1)
    }
  })

  test('greys have no chroma', () => {
    expect(rgbToOklch({ r: 128, g: 128, b: 128 }).c).toBeLessThan(1e-4)
  })
})

describe('ensureReadable', () => {
  test('returns the accent untouched when it already reads', () => {
    const readable: Rgb = { r: 51, g: 51, b: 51 }
    expect(ensureReadable(readable, WHITE)).toBe(readable)
  })

  test('darkens a light accent on a light background while keeping its hue', () => {
    const adjusted = ensureReadable(LIME, WHITE)

    expect(contrastRatio(adjusted, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(hueDelta(rgbToOklch(adjusted).h, rgbToOklch(LIME).h)).toBeLessThan(2)
    expect(rgbToOklch(adjusted).l).toBeLessThan(rgbToOklch(LIME).l)
  })

  test('lightens a dark accent on a dark background while keeping its hue', () => {
    const navy: Rgb = { r: 40, g: 40, b: 120 }
    const adjusted = ensureReadable(navy, DARK_BACKGROUND)

    expect(contrastRatio(adjusted, DARK_BACKGROUND)).toBeGreaterThanOrEqual(4.5)
    expect(hueDelta(rgbToOklch(adjusted).h, rgbToOklch(navy).h)).toBeLessThan(2)
    expect(rgbToOklch(adjusted).l).toBeGreaterThan(rgbToOklch(navy).l)
  })

  test('keeps some chroma rather than collapsing to grey', () => {
    expect(rgbToOklch(ensureReadable(LIME, WHITE)).c).toBeGreaterThan(0.05)
  })

  test('honours a custom minimum ratio', () => {
    const adjusted = ensureReadable(LIME, WHITE, 7)
    expect(contrastRatio(adjusted, WHITE)).toBeGreaterThanOrEqual(7)
  })

  test('falls back to the best end when the target is unreachable', () => {
    const midGrey: Rgb = { r: 128, g: 128, b: 128 }
    const adjusted = ensureReadable(LIME, midGrey, 21)

    // 21:1 is impossible against mid grey; take whichever extreme reads best.
    expect(contrastRatio(adjusted, midGrey)).toBeGreaterThan(contrastRatio(LIME, midGrey))
  })
})

describe('formatRgb', () => {
  test('emits the rounded css function', () => {
    expect(formatRgb({ r: 12.4, g: 200.6, b: 0 })).toBe('rgb(12, 201, 0)')
  })
})
