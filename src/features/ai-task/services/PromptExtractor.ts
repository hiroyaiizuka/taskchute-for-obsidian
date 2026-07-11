/**
 * AI Task - prompt extractor
 *
 * Extracts the body of the level-2 "Prompt" section from a task note.
 * Accepts optional heading metadata (structurally compatible with Obsidian's
 * HeadingCache) and falls back to a line-based regex scan when the metadata
 * does not contain a Prompt heading. Pure; CRLF-safe.
 */

const PROMPT_HEADING = 'prompt'
const PROMPT_HEADING_LINE = /^##[ \t]+prompt[ \t]*#*[ \t]*$/i
const STOP_HEADING_LINE = /^#{1,2}[ \t]+\S/

/** Minimal heading shape; Obsidian's HeadingCache is assignable to this */
export interface PromptHeadingInfo {
  heading: string
  level: number
  position: { start: { line: number } }
}

function toBody(lines: string[], start: number, end: number): string | null {
  const body = lines.slice(start, end).join('\n').trim()
  return body.length > 0 ? body : null
}

function extractUsingHeadings(
  lines: string[],
  headings: PromptHeadingInfo[],
): string | null {
  const promptIndex = headings.findIndex(
    (entry) =>
      entry.level === 2 &&
      entry.heading.trim().toLowerCase() === PROMPT_HEADING,
  )
  if (promptIndex < 0) return null

  const startLine = headings[promptIndex].position.start.line + 1
  let endLine = lines.length
  for (let index = promptIndex + 1; index < headings.length; index += 1) {
    if (headings[index].level <= 2) {
      endLine = headings[index].position.start.line
      break
    }
  }
  return toBody(lines, startLine, endLine)
}

function extractUsingRegex(lines: string[]): string | null {
  const headingLine = lines.findIndex((line) => PROMPT_HEADING_LINE.test(line))
  if (headingLine < 0) return null

  let endLine = lines.length
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    if (STOP_HEADING_LINE.test(lines[index])) {
      endLine = index
      break
    }
  }
  return toBody(lines, headingLine + 1, endLine)
}

/**
 * Extract the prompt section body from note content.
 * Returns null when no level-2 "Prompt" heading exists or its body is empty.
 */
export function extractPromptSection(
  content: string,
  headings?: PromptHeadingInfo[],
): string | null {
  const lines = content.split(/\r?\n/)

  if (headings && headings.length > 0) {
    const fromHeadings = extractUsingHeadings(lines, headings)
    if (fromHeadings !== null) return fromHeadings
  }

  return extractUsingRegex(lines)
}
