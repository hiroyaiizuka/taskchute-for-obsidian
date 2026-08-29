/**
 * Colour helpers used to keep theme accent colours readable.
 *
 * The plugin paints task names with the theme's `--text-accent`, which some
 * themes set to a very light hue (lime, yellow) that disappears against the
 * light background. Rather than dropping the accent we keep its hue and move
 * only lightness/chroma until the WCAG contrast ratio is acceptable, so the
 * result still reads as "the theme's accent".
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Oklch {
  l: number
  c: number
  h: number
}

const RGB_FUNCTION = /^rgba?\(([^)]+)\)$/i

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * Parse the normalised `rgb()` / `rgba()` form the browser hands back from
 * `getComputedStyle`. Both the legacy comma syntax and the modern space
 * syntax (`rgb(0 0 0 / 50%)`) are accepted; the alpha channel is ignored.
 */
export function parseRgbFunction(value: string): Rgb | null {
  const match = RGB_FUNCTION.exec(value.trim())
  if (!match) return null

  const channels = match[1]
    .split('/')[0]
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
  if (channels.length < 3) return null

  const parsed = channels.slice(0, 3).map((channel) => {
    if (channel.endsWith('%')) {
      const percent = Number.parseFloat(channel.slice(0, -1))
      return Number.isFinite(percent) ? (percent / 100) * 255 : Number.NaN
    }
    return Number.parseFloat(channel)
  })
  if (parsed.some((channel) => !Number.isFinite(channel))) return null

  const [r, g, b] = parsed
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255) }
}

export function formatRgb(rgb: Rgb): string {
  const round = (channel: number) => Math.round(clamp(channel, 0, 255))
  return `rgb(${round(rgb.r)}, ${round(rgb.g)}, ${round(rgb.b)})`
}

const srgbToLinear = (channel: number): number => {
  const normalized = channel / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

const linearToSrgb = (channel: number): number => {
  const encoded =
    channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055
  return encoded * 255
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) +
    0.7152 * srgbToLinear(rgb.g) +
    0.0722 * srgbToLinear(rgb.b)
  )
}

/** WCAG 2.x contrast ratio; 1 for identical colours, 21 for black on white. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminanceA = relativeLuminance(a)
  const luminanceB = relativeLuminance(b)
  const lighter = Math.max(luminanceA, luminanceB)
  const darker = Math.min(luminanceA, luminanceB)
  return (lighter + 0.05) / (darker + 0.05)
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const chroma = Math.sqrt(okA * okA + okB * okB)
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360

  return { l: okL, c: chroma, h: hue }
}

/**
 * Convert back to sRGB without clamping, so callers can tell whether the
 * colour actually fits inside the gamut.
 */
function oklchToRgbUnclamped(oklch: Oklch): Rgb {
  const hueRadians = (oklch.h * Math.PI) / 180
  const okA = oklch.c * Math.cos(hueRadians)
  const okB = oklch.c * Math.sin(hueRadians)

  const l = Math.pow(oklch.l + 0.3963377774 * okA + 0.2158037573 * okB, 3)
  const m = Math.pow(oklch.l - 0.1055613458 * okA - 0.0638541728 * okB, 3)
  const s = Math.pow(oklch.l - 0.0894841775 * okA - 1.291485548 * okB, 3)

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

const IN_GAMUT_TOLERANCE = 0.5

const isInGamut = (rgb: Rgb): boolean =>
  rgb.r >= -IN_GAMUT_TOLERANCE &&
  rgb.r <= 255 + IN_GAMUT_TOLERANCE &&
  rgb.g >= -IN_GAMUT_TOLERANCE &&
  rgb.g <= 255 + IN_GAMUT_TOLERANCE &&
  rgb.b >= -IN_GAMUT_TOLERANCE &&
  rgb.b <= 255 + IN_GAMUT_TOLERANCE

/**
 * Quantise to the 8-bit channels CSS will actually paint, so a contrast check
 * run here still holds once the colour is serialised.
 */
const clampRgb = (rgb: Rgb): Rgb => ({
  r: Math.round(clamp(rgb.r, 0, 255)),
  g: Math.round(clamp(rgb.g, 0, 255)),
  b: Math.round(clamp(rgb.b, 0, 255)),
})

/**
 * Bring an OKLCH colour into the sRGB gamut by lowering chroma only, keeping
 * lightness and hue intact. That is what preserves the "same colour, just
 * readable" feel when we push lightness around.
 */
export function clampToGamut(oklch: Oklch): Rgb {
  const direct = oklchToRgbUnclamped(oklch)
  if (isInGamut(direct)) return clampRgb(direct)

  let low = 0
  let high = oklch.c
  let best = clampRgb(oklchToRgbUnclamped({ ...oklch, c: 0 }))

  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2
    const candidate = oklchToRgbUnclamped({ ...oklch, c: mid })
    if (isInGamut(candidate)) {
      best = clampRgb(candidate)
      low = mid
    } else {
      high = mid
    }
  }

  return best
}

export function oklchToRgb(oklch: Oklch): Rgb {
  return clampToGamut(oklch)
}

export const DEFAULT_MIN_CONTRAST = 4.5

/**
 * Return `foreground` when it already reads against `background`; otherwise
 * return the closest colour of the same hue that reaches `minRatio`.
 */
export function ensureReadable(
  foreground: Rgb,
  background: Rgb,
  minRatio: number = DEFAULT_MIN_CONTRAST,
): Rgb {
  if (contrastRatio(foreground, background) >= minRatio) return foreground

  const source = rgbToOklch(foreground)
  // Dark backgrounds need a lighter accent, light backgrounds a darker one.
  const towardsLighter = relativeLuminance(background) < 0.5
  const limit = towardsLighter ? 1 : 0

  const at = (lightness: number): Rgb => clampToGamut({ ...source, l: lightness })

  const extreme = at(limit)
  if (contrastRatio(extreme, background) < minRatio) {
    // Even the extreme cannot satisfy the target (e.g. a mid-grey background).
    // Take whichever end reads best rather than leaving the accent as-is.
    const other = at(towardsLighter ? 0 : 1)
    return contrastRatio(other, background) > contrastRatio(extreme, background)
      ? other
      : extreme
  }

  // Binary search for the lightness closest to the original that still reads.
  let insufficient = source.l
  let sufficient = limit
  for (let i = 0; i < 24; i += 1) {
    const mid = (insufficient + sufficient) / 2
    if (contrastRatio(at(mid), background) >= minRatio) {
      sufficient = mid
    } else {
      insufficient = mid
    }
  }

  return at(sufficient)
}
