import type {
  RecipeConstraint,
  RecipeDocumentData,
  RecipeDocumentStringifyInput,
  RecipeQualityCheck,
  RecipeStep,
} from '../types'

type SectionName = 'goal' | 'checklist' | 'quality-checklist' | 'constraints'

interface LineSpan {
  text: string
  start: number
  end: number
  endWithBreak: number
}

interface FrontmatterRegion {
  bodyStart: number
  bodyEnd: number
  documentBodyStart: number
}

interface MarkerRange {
  start: number
  end: number
  contentStart: number
  contentEnd: number
}

const SECTION_NAMES: SectionName[] = ['goal', 'checklist', 'quality-checklist', 'constraints']
const STEP_ID_PATTERN = /^step-[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const QUALITY_CHECK_ID_PATTERN = /^quality-[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u
const RESERVED_MARKER_PATTERN = /<!--\s*taskchute-(?:recipe:|step-id:|quality-check-id:)/iu

function startMarker(name: SectionName): string {
  return `<!-- taskchute-recipe:${name}:start -->`
}

function endMarker(name: SectionName): string {
  return `<!-- taskchute-recipe:${name}:end -->`
}

function hashText(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(36)
}

function idForOccurrence(prefix: 'step' | 'constraint', text: string, occurrenceIndex: number): string {
  const baseId = `${prefix}-${hashText(text.trim())}`
  return occurrenceIndex === 0 ? baseId : `${baseId}-${occurrenceIndex + 1}`
}

function splitLines(markdown: string): LineSpan[] {
  const spans: LineSpan[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    if (match[0].length === 0) break
    const start = match.index
    const text = match[1]
    spans.push({
      text,
      start,
      end: start + text.length,
      endWithBreak: start + match[0].length,
    })
  }
  return spans
}

function detectNewline(markdown: string): string {
  return markdown.includes('\r\n') ? '\r\n' : '\n'
}

function findFrontmatterRegion(markdown: string): FrontmatterRegion | undefined {
  const lines = splitLines(markdown)
  if (lines[0]?.text !== '---') return undefined
  const closing = lines.slice(1).find((line) => line.text === '---')
  if (!closing) return undefined
  return {
    bodyStart: lines[0].endWithBreak,
    bodyEnd: closing.start,
    documentBodyStart: closing.endWithBreak,
  }
}

function assertFrontmatterIsClosed(markdown: string): void {
  if (splitLines(markdown)[0]?.text === '---' && !findFrontmatterRegion(markdown)) {
    throw new RecipeDocumentCorruptError('Recipe frontmatter is not closed')
  }
}

function parseYamlScalar(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return trimmed.replace(/^"|"$/gu, '')
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'")
  }
  return trimmed
}

function readFrontmatterValue(markdown: string, key: string): string | undefined {
  const frontmatter = findFrontmatterRegion(markdown)
  if (!frontmatter) return undefined
  const lines = markdown.slice(frontmatter.bodyStart, frontmatter.bodyEnd).split(/\r?\n|\r/u)
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:\\s*(.*?)\\s*$`, 'u')
  for (const line of lines) {
    const match = line.match(keyPattern)
    if (match) return parseYamlScalar(match[1])
  }
  return undefined
}

function hasFrontmatterKey(markdown: string, key: string): boolean {
  const frontmatter = findFrontmatterRegion(markdown)
  if (!frontmatter) return false
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:`, 'u')
  return markdown
    .slice(frontmatter.bodyStart, frontmatter.bodyEnd)
    .split(/\r?\n|\r/u)
    .some((line) => keyPattern.test(line))
}

function parseVersion(markdown: string): 1 | 2 {
  const value = readFrontmatterValue(markdown, 'taskchute_recipe_version')
  if (value === undefined) {
    if (hasFrontmatterKey(markdown, 'taskchute_recipe_version')) {
      throw new RecipeDocumentCorruptError('Recipe schema version is empty or invalid')
    }
    return 1
  }
  if (value === '1') return 1
  if (value === '2') return 2
  throw new RecipeDocumentCorruptError(`Unsupported Recipe schema version: ${value}`)
}

function countOccurrences(markdown: string, needle: string): number {
  let count = 0
  let fromIndex = 0
  while (true) {
    const index = markdown.indexOf(needle, fromIndex)
    if (index < 0) return count
    count += 1
    fromIndex = index + needle.length
  }
}

function getDocumentBodyStart(markdown: string): number {
  return findFrontmatterRegion(markdown)?.documentBodyStart ?? 0
}

function hasAnyManagedMarker(markdown: string): boolean {
  return RESERVED_MARKER_PATTERN.test(markdown.slice(getDocumentBodyStart(markdown)))
}

function findMarkerRanges(markdown: string, requireAll: boolean): Map<SectionName, MarkerRange> {
  const ranges = new Map<SectionName, MarkerRange>()
  const bodyStart = getDocumentBodyStart(markdown)
  const body = markdown.slice(bodyStart)
  let previousEnd = -1
  for (const name of SECTION_NAMES) {
    const start = startMarker(name)
    const end = endMarker(name)
    const startCount = countOccurrences(body, start)
    const endCount = countOccurrences(body, end)
    if (startCount === 0 && endCount === 0 && !requireAll) continue
    if (startCount !== 1 || endCount !== 1) {
      throw new RecipeDocumentCorruptError(`Recipe section "${name}" must have exactly one marker pair`)
    }
    const startIndex = bodyStart + body.indexOf(start)
    const endIndex = bodyStart + body.indexOf(end)
    if (endIndex < startIndex + start.length) {
      throw new RecipeDocumentCorruptError(`Recipe section "${name}" markers are reversed or overlapping`)
    }
    if (startIndex < previousEnd) {
      throw new RecipeDocumentCorruptError('Recipe section markers are crossed or out of order')
    }
    const range = {
      start: startIndex,
      end: endIndex + end.length,
      contentStart: startIndex + start.length,
      contentEnd: endIndex,
    }
    ranges.set(name, range)
    previousEnd = range.end
  }
  return ranges
}

function stripManagedHeading(content: string): string {
  const lines = content.replace(/^\s*(?:\r\n|\n|\r)?/u, '').split(/\r?\n|\r/u)
  if (/^\s*#{1,6}\s+/u.test(lines[0] ?? '')) lines.shift()
  return lines.join('\n').trim()
}

function getManagedSectionLines(content: string, expectedHeading: string): string[] {
  const lines = content.split(/\r?\n|\r/u)
  while (lines[0]?.trim() === '') lines.shift()
  while (lines[lines.length - 1]?.trim() === '') lines.pop()
  if (lines[0]?.trim() === `## ${expectedHeading}`) lines.shift()
  return lines
}

function parseChecklist(
  content: string,
  kind: 'step' | 'quality',
  requireIds: boolean,
): Array<RecipeStep | RecipeQualityCheck> {
  const items: Array<RecipeStep | RecipeQualityCheck> = []
  const seenIds = new Set<string>()
  const idPattern = kind === 'step' ? STEP_ID_PATTERN : QUALITY_CHECK_ID_PATTERN
  const markerPattern = kind === 'step'
    ? /\s*<!--\s*taskchute-step-id:\s*([^\s>]+)\s*-->\s*$/u
    : /\s*<!--\s*taskchute-quality-check-id:\s*([^\s>]+)\s*-->\s*$/u

  const expectedHeading = kind === 'step' ? '手順チェックリスト' : '品質基準チェックリスト'
  for (const line of getManagedSectionLines(content, expectedHeading)) {
    if (line.trim() === '') continue
    const idMatch = line.match(markerPattern)
    const checkboxPart = idMatch && typeof idMatch.index === 'number' ? line.slice(0, idMatch.index) : line
    const checkbox = checkboxPart.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/u)
    if (!checkbox) {
      throw new RecipeDocumentCorruptError(`Recipe ${kind} section contains an invalid line: ${line}`)
    }
    const text = checkbox[1].trim()
    if (!text) {
      throw new RecipeDocumentCorruptError(`Recipe ${kind} item text is empty`)
    }
    const id = idMatch?.[1]
    if (!id && requireIds) {
      throw new RecipeDocumentCorruptError(`Recipe ${kind} item is missing its stable ID`)
    }
    if (!id) continue
    if (!idPattern.test(id)) {
      throw new RecipeDocumentCorruptError(`Recipe ${kind} item has an invalid ID: ${id}`)
    }
    if (seenIds.has(id)) {
      throw new RecipeDocumentCorruptError(`Recipe ${kind} item ID is duplicated: ${id}`)
    }
    seenIds.add(id)
    items.push({ id, text })
  }
  return items
}

function parseLegacySteps(markdown: string): RecipeStep[] {
  const steps: RecipeStep[] = []
  const occurrenceByText = new Map<string, number>()
  const bodyStart = findFrontmatterRegion(markdown)?.documentBodyStart ?? 0
  for (const line of splitLines(markdown)) {
    if (line.start < bodyStart) continue
    const match = line.text.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/u)
    if (!match) continue
    const text = match[1].trim()
    if (!text) continue
    const occurrenceIndex = occurrenceByText.get(text) ?? 0
    occurrenceByText.set(text, occurrenceIndex + 1)
    steps.push({ id: idForOccurrence('step', text, occurrenceIndex), text })
  }
  return steps
}

function parseConstraints(content: string): RecipeConstraint[] {
  const constraints: RecipeConstraint[] = []
  const occurrenceByText = new Map<string, number>()
  for (const line of getManagedSectionLines(content, '制約・ルール')) {
    if (line.trim() === '') continue
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/u)
    if (!match) {
      throw new RecipeDocumentCorruptError(`Recipe constraint section contains an invalid line: ${line}`)
    }
    const text = match[1].trim()
    if (!text) {
      throw new RecipeDocumentCorruptError('Recipe constraint text is empty')
    }
    const occurrenceIndex = occurrenceByText.get(text) ?? 0
    occurrenceByText.set(text, occurrenceIndex + 1)
    constraints.push({ id: idForOccurrence('constraint', text, occurrenceIndex), text })
  }
  return constraints
}

function validateInput(input: RecipeDocumentStringifyInput): void {
  const values = [
    input.title,
    input.goal,
    ...input.steps.map((step) => step.text),
    ...input.qualityChecks.map((check) => check.text),
    ...input.constraints,
  ]
  for (const value of values) {
    if (value.includes('\0')) throw new RecipeDocumentInputError('Recipe content cannot contain NUL characters')
    if (RESERVED_MARKER_PATTERN.test(value)) {
      throw new RecipeDocumentInputError('Recipe content cannot contain reserved TaskChute markers')
    }
  }
  const singleLineValues = [
    ...input.steps.map((step) => step.text),
    ...input.qualityChecks.map((check) => check.text),
    ...input.constraints,
  ]
  if (singleLineValues.some((value) => /[\r\n]/u.test(value))) {
    throw new RecipeDocumentInputError(
      'Recipe checklist items and constraints must each fit on one line',
    )
  }
  validateItemIds(input.steps, STEP_ID_PATTERN, 'step')
  validateItemIds(input.qualityChecks, QUALITY_CHECK_ID_PATTERN, 'quality check')
}

function validateItemIds(
  items: Array<{ id: string }>,
  pattern: RegExp,
  label: string,
): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (!pattern.test(item.id)) throw new RecipeDocumentInputError(`Invalid recipe ${label} ID: ${item.id}`)
    if (seen.has(item.id)) throw new RecipeDocumentInputError(`Duplicate recipe ${label} ID: ${item.id}`)
    seen.add(item.id)
  }
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}

function normalizeNewlines(value: string, newline: string): string {
  return value.replace(/\r\n|\r|\n/gu, newline)
}

function assertManagedFrontmatterIsRewritable(markdown: string): void {
  const region = findFrontmatterRegion(markdown)
  if (!region) return
  const lines = markdown.slice(region.bodyStart, region.bodyEnd).split(/\r?\n|\r/u)
  const managedKey = /^(?:taskchute_recipe|taskchute_recipe_version|title)\s*:\s*(.*?)\s*$/u
  for (const line of lines) {
    const match = line.match(managedKey)
    if (!match) continue
    if (/^[>|](?:[1-9]?[+-]?|[+-]?[1-9]?)?(?:\s+#.*)?$/u.test(match[1].trim())) {
      throw new RecipeMigrationNeedsReviewError(
        'Managed Recipe frontmatter uses a YAML block scalar and requires review',
        createMigrationPreview(markdown),
      )
    }
  }
}

function updateFrontmatter(markdown: string, input: RecipeDocumentStringifyInput, newline: string): string {
  const region = findFrontmatterRegion(markdown)
  const managedLines = [
    'taskchute_recipe: true',
    'taskchute_recipe_version: 2',
    `title: ${quoteYamlString(input.title)}`,
  ]
  if (!region) {
    return ['---', ...managedLines, '---', '', markdown].join(newline)
  }
  const body = markdown.slice(region.bodyStart, region.bodyEnd)
  const unknownLines = body
    .split(/\r?\n|\r/u)
    .filter((line) => !/^(?:taskchute_recipe|taskchute_recipe_version|title)\s*:/u.test(line))
  while (unknownLines[0] === '') unknownLines.shift()
  while (unknownLines[unknownLines.length - 1] === '') unknownLines.pop()
  const nextBody = [...unknownLines, ...managedLines].join(newline)
  return `${markdown.slice(0, region.bodyStart)}${nextBody}${newline}${markdown.slice(region.bodyEnd)}`
}

function renderSection(name: SectionName, heading: string, lines: string[], newline: string): string {
  return [
    startMarker(name),
    `## ${heading}`,
    '',
    ...lines.map((line) => normalizeNewlines(line, newline)),
    endMarker(name),
  ].join(newline)
}

function renderManagedSections(input: RecipeDocumentStringifyInput, newline: string): string {
  const sections = [
    renderSection('goal', '完了基準', input.goal ? [input.goal] : [], newline),
    renderSection(
      'checklist',
      '手順チェックリスト',
      input.steps.map((step) => `- [ ] ${step.text} <!-- taskchute-step-id: ${step.id} -->`),
      newline,
    ),
    renderSection(
      'quality-checklist',
      '品質基準チェックリスト',
      input.qualityChecks.map(
        (check) => `- [ ] ${check.text} <!-- taskchute-quality-check-id: ${check.id} -->`,
      ),
      newline,
    ),
    renderSection('constraints', '制約・ルール', input.constraints.map((constraint) => `- ${constraint}`), newline),
  ]
  return sections.join(`${newline}${newline}`)
}

function replaceV2Sections(markdown: string, input: RecipeDocumentStringifyInput, newline: string): string {
  const ranges = findMarkerRanges(markdown, true)
  let next = markdown
  const replacements = SECTION_NAMES.map((name) => ({
    name,
    range: ranges.get(name) as MarkerRange,
  })).sort((left, right) => right.range.start - left.range.start)
  const headings: Record<SectionName, string> = {
    goal: '完了基準',
    checklist: '手順チェックリスト',
    'quality-checklist': '品質基準チェックリスト',
    constraints: '制約・ルール',
  }
  for (const { name, range } of replacements) {
    let lines: string[]
    if (name === 'goal') lines = input.goal ? [input.goal] : []
    else if (name === 'checklist') {
      lines = input.steps.map((step) => `- [ ] ${step.text} <!-- taskchute-step-id: ${step.id} -->`)
    } else if (name === 'quality-checklist') {
      lines = input.qualityChecks.map(
        (check) => `- [ ] ${check.text} <!-- taskchute-quality-check-id: ${check.id} -->`,
      )
    } else lines = input.constraints.map((constraint) => `- ${constraint}`)
    const rendered = renderSection(name, headings[name], lines, newline)
    next = `${next.slice(0, range.start)}${rendered}${next.slice(range.end)}`
  }
  return next
}

function findLegacyChecklistRange(markdown: string): { start: number; end: number } | undefined {
  const lines = splitLines(markdown)
  const documentBodyStart = findFrontmatterRegion(markdown)?.documentBodyStart ?? 0
  const checkboxLines: LineSpan[] = []
  let insideFence = false
  let hasCheckboxInFence = false
  for (const line of lines) {
    if (line.start < documentBodyStart) continue
    if (/^\s*```/u.test(line.text) || /^\s*~~~/u.test(line.text)) {
      insideFence = !insideFence
      continue
    }
    if (!/^\s*[-*]\s+\[[ xX]\]\s+.+?\s*$/u.test(line.text)) continue
    if (insideFence) {
      hasCheckboxInFence = true
      continue
    }
    if (/^\s/u.test(line.text)) {
      throw new RecipeMigrationNeedsReviewError('Nested legacy checklist items require review', createMigrationPreview(markdown))
    }
    checkboxLines.push(line)
  }
  if (hasCheckboxInFence) {
    throw new RecipeMigrationNeedsReviewError(
      'Checklist-like content inside a code fence requires review',
      createMigrationPreview(markdown),
    )
  }
  if (checkboxLines.length === 0) return undefined
  for (let index = 1; index < checkboxLines.length; index += 1) {
    if (checkboxLines[index - 1].endWithBreak !== checkboxLines[index].start) {
      throw new RecipeMigrationNeedsReviewError('Scattered legacy checklist blocks require review', createMigrationPreview(markdown))
    }
  }
  return {
    start: checkboxLines[0].start,
    end: checkboxLines[checkboxLines.length - 1].endWithBreak,
  }
}

function createMigrationPreview(markdown: string): string {
  const maximumLength = 2000
  return markdown.length <= maximumLength ? markdown : `${markdown.slice(0, maximumLength)}\n…`
}

function migrateV1(markdown: string, input: RecipeDocumentStringifyInput, newline: string): string {
  const managed = renderManagedSections(input, newline)
  const legacyRange = findLegacyChecklistRange(markdown)
  if (legacyRange) {
    const suffix = markdown.slice(legacyRange.end)
    const separator = suffix.length > 0 && !suffix.startsWith(newline) ? newline : ''
    return `${markdown.slice(0, legacyRange.start)}${managed}${newline}${separator}${suffix}`
  }
  const frontmatter = findFrontmatterRegion(markdown)
  const insertAt = frontmatter?.documentBodyStart ?? 0
  const prefix = markdown.slice(0, insertAt)
  const suffix = markdown.slice(insertAt)
  const before = prefix.length > 0 && !prefix.endsWith(newline) ? newline : ''
  const after = suffix.length > 0 ? `${newline}${newline}` : newline
  return `${prefix}${before}${managed}${after}${suffix}`
}

export class RecipeDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class RecipeDocumentCorruptError extends RecipeDocumentError {}

export class RecipeDocumentInputError extends RecipeDocumentError {}

export class RecipeMigrationNeedsReviewError extends RecipeDocumentError {
  readonly preview: string

  constructor(message: string, preview = '') {
    super(message)
    this.preview = preview
  }
}

export class RecipeDocumentCodec {
  parse(markdown: string): RecipeDocumentData {
    assertFrontmatterIsClosed(markdown)
    const schemaVersion = parseVersion(markdown)
    const title = readFrontmatterValue(markdown, 'title')?.trim() || undefined
    const hasAnyMarkers = hasAnyManagedMarker(markdown)

    if (schemaVersion === 1 && !hasAnyMarkers) {
      return {
        schemaVersion,
        title,
        goal: '',
        steps: parseLegacySteps(markdown),
        qualityChecks: [],
        constraints: [],
      }
    }
    if (schemaVersion !== 2) {
      throw new RecipeDocumentCorruptError('Managed Recipe v2 markers require taskchute_recipe_version: 2')
    }
    if (readFrontmatterValue(markdown, 'taskchute_recipe') !== 'true') {
      throw new RecipeDocumentCorruptError('Recipe v2 requires taskchute_recipe: true')
    }

    const ranges = findMarkerRanges(markdown, true)
    const section = (name: SectionName): string => {
      const range = ranges.get(name) as MarkerRange
      return markdown.slice(range.contentStart, range.contentEnd)
    }
    return {
      schemaVersion,
      title,
      goal: stripManagedHeading(section('goal')),
      steps: parseChecklist(section('checklist'), 'step', true),
      qualityChecks: parseChecklist(section('quality-checklist'), 'quality', true),
      constraints: parseConstraints(section('constraints')),
    }
  }

  stringify(markdown: string | undefined, input: RecipeDocumentStringifyInput): string {
    validateInput(input)
    const original = markdown ?? ''
    assertFrontmatterIsClosed(original)
    assertManagedFrontmatterIsRewritable(original)
    const newline = detectNewline(original)
    if (!original) {
      const body = renderManagedSections(input, newline)
      return updateFrontmatter(`${body}${newline}`, input, newline)
    }

    const parsedVersion = parseVersion(original)
    const hasAnyMarkers = hasAnyManagedMarker(original)
    let next: string
    if (parsedVersion === 2 || hasAnyMarkers) {
      if (parsedVersion !== 2) {
        throw new RecipeDocumentCorruptError('Managed Recipe v2 markers require taskchute_recipe_version: 2')
      }
      next = replaceV2Sections(original, input, newline)
    } else {
      next = migrateV1(original, input, newline)
    }
    return updateFrontmatter(next, input, newline)
  }
}

export const RECIPE_STEP_ID_PATTERN = STEP_ID_PATTERN
export const RECIPE_QUALITY_CHECK_ID_PATTERN = QUALITY_CHECK_ID_PATTERN
