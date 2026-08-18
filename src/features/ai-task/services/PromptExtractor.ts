/**
 * AI Task - prompt extractor
 *
 * Extracts the body of the level-2 "Prompt" section from a task note.
 * Accepts optional heading metadata (structurally compatible with Obsidian's
 * HeadingCache) and falls back to a line-based regex scan when the metadata
 * does not contain a Prompt heading. Pure; CRLF-safe.
 *
 * Body lines whose leading hash is backslash-escaped (`\#`, `\\##`, and the
 * same behind 1-3 spaces of indentation, per CommonMark's heading rules)
 * have exactly ONE backslash stripped: TaskCreationService escapes
 * hash-leading prompt lines at write time (a raw `# Overview` inside a
 * pasted prompt would otherwise terminate the section here AND in Obsidian's
 * heading cache), and this is the symmetric read-time inverse. The escape is
 * also correct Markdown — `\#` renders as a literal hash — so hand-authored
 * `\#` lines extract as the hash text their author sees rendered.
 */

const PROMPT_HEADING = 'prompt'
export const EXACT_PROMPT_START_MARKER = '<!-- taskchute-ai-prompt:start -->'
export const EXACT_PROMPT_END_MARKER = '<!-- taskchute-ai-prompt:end -->'
const PROMPT_HEADING_LINE = /^##[ \t]+prompt[ \t]*#*[ \t]*$/i
// CommonMark (and Obsidian's heading cache) still parses an ATX heading
// behind 1-3 leading spaces; four spaces make an indented code block. Both
// the stop condition and the escape pair must follow that boundary.
const STOP_HEADING_LINE = /^ {0,3}#{1,2}[ \t]+\S/
const ESCAPED_HASH_LINE = /^ {0,3}\\+#/

/** Inverse of TaskCreationService's write-time hash-line escaping */
function unescapePromptLine(line: string): string {
  return ESCAPED_HASH_LINE.test(line) ? line.replace(/^( {0,3})\\/, '$1') : line
}

/** Minimal heading shape; Obsidian's HeadingCache is assignable to this */
export interface PromptHeadingInfo {
  heading: string
  level: number
  position: { start: { line: number } }
}

function toBody(lines: string[], start: number, end: number): string | null {
  const bodyLines = lines.slice(start, end)
  const exactStart = bodyLines.indexOf(EXACT_PROMPT_START_MARKER)
  const exactEnd = bodyLines.lastIndexOf(EXACT_PROMPT_END_MARKER)
  if (exactStart >= 0 && exactEnd > exactStart) {
    const exactBody = bodyLines
      .slice(exactStart + 1, exactEnd)
      .map(unescapePromptLine)
      .join('\n')
    return exactBody.trim().length > 0 ? exactBody : null
  }

  const body = bodyLines.map(unescapePromptLine).join('\n').trim()
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
