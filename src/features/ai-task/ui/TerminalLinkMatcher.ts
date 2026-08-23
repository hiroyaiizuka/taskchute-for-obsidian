/**
 * A local-file reference found in rendered terminal text.
 *
 * This module is deliberately independent from xterm. Regex/string offsets
 * are UTF-16 offsets; the xterm adapter translates them to terminal cells.
 */
export interface TerminalFileLinkMatch {
  /** Filesystem path (file:// references are decoded to a local path). */
  path: string
  /** Optional one-based source line suffix. */
  line?: number
  /** Optional one-based source column suffix. */
  column?: number
  /** Inclusive UTF-16 offset in the input text. */
  startIndex: number
  /** Exclusive UTF-16 offset in the input text. */
  endIndex: number
  /** Exact terminal text covered by the link range. */
  fullMatch: string
}

interface ParsedReference {
  path: string
  line?: number
  column?: number
}

interface CoveredRange {
  start: number
  end: number
}

const TOOL_ACTION_REGEX =
  /\b(?:Read|Edit|Write|Update|Create|Delete|Rename|Move|Copy)\s*\(([^)\n]*)\)/g
const QUOTED_REFERENCE_REGEX = /(["'`])([^"'`\n]+)\1/g
const URI_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g
const TOKEN_REGEX = new RegExp("[^\\s<>\"'`()\\[\\]{},;!?]+", 'g')
const LOCATION_SUFFIX_REGEX = /:(\d+)(?::(\d+))?$/
const WINDOWS_ABSOLUTE_REGEX = /^[A-Za-z]:[\\/]/
const EXPLICIT_RELATIVE_REGEX = /^\.{1,2}[\\/]/
const TRAILING_TOKEN_PUNCTUATION_REGEX = /[.:]+$/
const WELL_KNOWN_BARE_FILES = new Set([
  '.env',
  '.gitignore',
  '.npmrc',
  'agents.md',
  'bun.lock',
  'bun.lockb',
  'claude.md',
  'jsconfig.json',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'readme.md',
  'tsconfig.json',
  'yarn.lock',
])

function rangesOverlap(
  start: number,
  end: number,
  range: CoveredRange,
): boolean {
  return start < range.end && end > range.start
}

function isCovered(
  start: number,
  end: number,
  coveredRanges: CoveredRange[],
): boolean {
  return coveredRanges.some((range) => rangesOverlap(start, end, range))
}

function trimReference(raw: string): {
  value: string
  leadingLength: number
} {
  let value = raw.trim()
  let leadingLength = raw.length - raw.trimStart().length
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'" || first === '`') && last === first) {
      const inner = value.slice(1, -1)
      leadingLength += 1 + (inner.length - inner.trimStart().length)
      value = inner.trim()
    }
  }
  return { value, leadingLength }
}

function splitLocationSuffix(value: string): ParsedReference {
  const suffix = LOCATION_SUFFIX_REGEX.exec(value)
  if (!suffix) return { path: value }
  const path = value.slice(0, suffix.index)
  if (path.length === 0) return { path: value }
  return {
    path,
    line: Number.parseInt(suffix[1], 10),
    column: suffix[2] ? Number.parseInt(suffix[2], 10) : undefined,
  }
}

function decodeFileUriPath(uriPath: string): string | null {
  const lower = uriPath.toLowerCase()
  if (!lower.startsWith('file://')) return null

  let path = uriPath.slice('file://'.length)
  if (path.toLowerCase().startsWith('localhost/')) {
    path = path.slice('localhost'.length)
  } else if (!path.startsWith('/')) {
    // Preserve a non-local authority as a UNC-style path. The workspace
    // boundary validates whether it is usable on the current platform.
    path = `//${path}`
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  // file:///C:/... is the conventional Windows file URI spelling.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1)
  return path
}

function hasFileExtension(path: string): boolean {
  const segments = path.split(/[\\/]/)
  const filename = segments[segments.length - 1] ?? ''
  return (
    filename.length > 0 &&
    filename !== '.' &&
    filename !== '..' &&
    (filename.startsWith('.') || /\.[^.:\\/]+$/.test(filename))
  )
}

function stripMatchingPathQuotes(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' || first === "'" || first === '`') && last === first) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function isLocalPath(
  path: string,
  allowToolPath: boolean,
  allowBareFile: boolean,
): boolean {
  if (path.length === 0) return false
  for (const character of path) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) return false
  if (allowToolPath) return true
  if (path.startsWith('/') || WINDOWS_ABSOLUTE_REGEX.test(path)) return true
  if (EXPLICIT_RELATIVE_REGEX.test(path)) return hasFileExtension(path)
  if (path.includes('/') || path.includes('\\')) return hasFileExtension(path)
  if (allowBareFile) return hasFileExtension(path)
  return WELL_KNOWN_BARE_FILES.has(path.toLowerCase())
}

function parseReference(
  raw: string,
  allowToolPath: boolean,
  allowBareFile: boolean,
): ParsedReference | null {
  const location = splitLocationSuffix(raw)
  const normalizedPath = stripMatchingPathQuotes(location.path)
  const fileUriPath = decodeFileUriPath(normalizedPath)
  if (fileUriPath !== null) {
    if (!isLocalPath(fileUriPath, true, true)) return null
    return { ...location, path: fileUriPath }
  }
  if (!isLocalPath(normalizedPath, allowToolPath, allowBareFile)) return null
  return { ...location, path: normalizedPath }
}

function addReference(
  matches: TerminalFileLinkMatch[],
  coveredRanges: CoveredRange[],
  raw: string,
  start: number,
  allowToolPath: boolean,
  allowBareFile: boolean,
): void {
  const trimmed = trimReference(raw)
  let fullMatch = trimmed.value
  let end = start + trimmed.leadingLength + fullMatch.length
  const adjustedStart = start + trimmed.leadingLength

  if (!allowToolPath) {
    const withoutTrailing = fullMatch.replace(TRAILING_TOKEN_PUNCTUATION_REGEX, '')
    end -= fullMatch.length - withoutTrailing.length
    fullMatch = withoutTrailing
  }
  if (
    fullMatch.length === 0 ||
    isCovered(adjustedStart, end, coveredRanges)
  ) {
    return
  }

  const parsed = parseReference(fullMatch, allowToolPath, allowBareFile)
  if (!parsed) return
  matches.push({
    ...parsed,
    startIndex: adjustedStart,
    endIndex: end,
    fullMatch,
  })
  coveredRanges.push({ start: adjustedStart, end })
}

/**
 * Find workspace-file references in one logical terminal line.
 *
 * Tool actions and quoted paths are processed first so paths containing
 * spaces or Japanese text stay intact. URI ranges are reserved before token
 * matching, preventing `/path/file.ts` inside an HTTP(S) URL from becoming a
 * local-file link. `file://` is the only URI scheme converted to a file link.
 */
export function findTerminalFileLinks(text: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = []
  const coveredRanges: CoveredRange[] = []

  URI_REGEX.lastIndex = 0
  let uriMatch: RegExpExecArray | null
  while ((uriMatch = URI_REGEX.exec(text)) !== null) {
    if (!uriMatch[0].toLowerCase().startsWith('file://')) {
      coveredRanges.push({
        start: uriMatch.index,
        end: uriMatch.index + uriMatch[0].length,
      })
    }
  }

  TOOL_ACTION_REGEX.lastIndex = 0
  let toolMatch: RegExpExecArray | null
  while ((toolMatch = TOOL_ACTION_REGEX.exec(text)) !== null) {
    const openParen = toolMatch[0].indexOf('(')
    const innerStart = toolMatch.index + openParen + 1
    addReference(matches, coveredRanges, toolMatch[1], innerStart, true, true)
    coveredRanges.push({
      start: toolMatch.index,
      end: toolMatch.index + toolMatch[0].length,
    })
  }

  QUOTED_REFERENCE_REGEX.lastIndex = 0
  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = QUOTED_REFERENCE_REGEX.exec(text)) !== null) {
    const start = quotedMatch.index + 1
    if (isCovered(start, start + quotedMatch[2].length, coveredRanges)) continue
    const afterQuote = quotedMatch.index + quotedMatch[0].length
    const outsideLocation = /^:(\d+)(?::(\d+))?/.exec(text.slice(afterQuote))
    if (outsideLocation) {
      const parsed = parseReference(
        `${quotedMatch[2]}${outsideLocation[0]}`,
        false,
        true,
      )
      if (parsed) {
        const rangeStart = quotedMatch.index
        const rangeEnd = afterQuote + outsideLocation[0].length
        matches.push({
          ...parsed,
          startIndex: rangeStart,
          endIndex: rangeEnd,
          fullMatch: text.slice(rangeStart, rangeEnd),
        })
        coveredRanges.push({ start: rangeStart, end: rangeEnd })
        continue
      }
    }
    addReference(matches, coveredRanges, quotedMatch[2], start, false, true)
  }

  TOKEN_REGEX.lastIndex = 0
  let tokenMatch: RegExpExecArray | null
  while ((tokenMatch = TOKEN_REGEX.exec(text)) !== null) {
    addReference(
      matches,
      coveredRanges,
      tokenMatch[0],
      tokenMatch.index,
      false,
      false,
    )
  }

  return matches.sort((left, right) => left.startIndex - right.startIndex)
}
