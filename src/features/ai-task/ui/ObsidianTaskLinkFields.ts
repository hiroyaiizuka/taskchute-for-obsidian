import { setIcon } from 'obsidian'
import type { App } from 'obsidian'
import type {
  ObsidianTaskLinkConfig,
  ObsidianTaskMatchType,
} from '../../../types/TaskFields'
import { resolveTaskDisplayTitle } from '../../../utils/taskDisplayTitle'
import { listFilesInFolder } from '../../../utils/vaultFiles'

export interface ObsidianTaskLinkFieldsOptions {
  parent: HTMLElement
  doc: Document
  app: App
  initialValue?: unknown
  excludePath?: string
  taskFolderPath?: string
  translate: (key: string, fallback: string) => string
}

export interface ObsidianTaskLinkFieldsController {
  readonly element: HTMLElement
  getValue: () => ObsidianTaskLinkConfig | null
  validate: () => string | null
  destroy: () => void
}

interface InitialValue {
  enabled: boolean
  taskTitle: string
  matchType: ObsidianTaskMatchType
}

let fieldSequence = 0

/** Build the Obsidian linkage block shared by both routine-edit entry points. */
export function createObsidianTaskLinkFields(
  options: ObsidianTaskLinkFieldsOptions,
): ObsidianTaskLinkFieldsController {
  const { parent, doc, app, translate } = options
  const initial = normalizeInitialValue(options.initialValue)
  const root = doc.win.createEl('section')
  root.className = 'form-group obsidian-task-link-fields'
  parent.appendChild(root)

  const heading = doc.win.createDiv()
  heading.className = 'obsidian-task-link-heading'
  const headingIcon = doc.win.createSpan()
  headingIcon.className = 'obsidian-task-link-heading-icon'
  setIcon(headingIcon, 'link-2')
  const headingText = doc.win.createSpan()
  headingText.textContent = translate('heading', 'Obsidian integration')
  heading.append(headingIcon, headingText)
  root.appendChild(heading)

  const enabledLabel = doc.win.createEl('label')
  enabledLabel.className = 'obsidian-task-link-toggle'
  const enabled = doc.win.createEl('input')
  enabled.type = 'checkbox'
  enabled.className = 'obsidian-task-link-enabled'
  enabled.checked = initial.enabled
  const enabledText = doc.win.createSpan()
  enabledText.textContent = translate('enabled', 'Link with Obsidian')
  enabledLabel.append(enabled, enabledText)
  root.appendChild(enabledLabel)

  const details = doc.win.createDiv()
  details.className = 'obsidian-task-link-details'
  root.appendChild(details)

  const titleLabel = doc.win.createEl('label')
  titleLabel.className = 'form-label'
  titleLabel.textContent = translate('taskTitle', 'Matching task name')
  details.appendChild(titleLabel)

  const autocomplete = doc.win.createDiv()
  autocomplete.className = 'obsidian-task-link-autocomplete'
  const titleInput = doc.win.createEl('input')
  titleInput.type = 'text'
  titleInput.className = 'form-input obsidian-task-link-title'
  titleInput.autocomplete = 'off'
  titleInput.placeholder = translate(
    'taskTitlePlaceholder',
    'Enter or select a task name',
  )
  titleInput.value = initial.taskTitle
  const suggestions = doc.win.createDiv()
  suggestions.className = 'obsidian-task-link-suggestions is-hidden'
  suggestions.setAttribute('role', 'listbox')
  autocomplete.append(titleInput, suggestions)
  details.appendChild(autocomplete)

  const matchLabel = doc.win.createDiv()
  matchLabel.className = 'form-label obsidian-task-link-match-label'
  matchLabel.textContent = translate('matchType', 'Match type')
  details.appendChild(matchLabel)

  const matchOptions = doc.win.createDiv()
  matchOptions.className = 'obsidian-task-link-match-options'
  const radioName = `obsidian-task-link-match-${fieldSequence += 1}`
  const radios = new Map<ObsidianTaskMatchType, HTMLInputElement>()
  const addRadio = (value: ObsidianTaskMatchType, labelText: string) => {
    const label = doc.win.createEl('label')
    label.className = 'obsidian-task-link-match-option'
    const radio = doc.win.createEl('input')
    radio.type = 'radio'
    radio.name = radioName
    radio.value = value
    radio.checked = initial.matchType === value
    label.append(radio, doc.createTextNode(labelText))
    matchOptions.appendChild(label)
    radios.set(value, radio)
  }
  addRadio('exact', translate('exact', 'Exact match'))
  addRadio('contains', translate('contains', 'Partial match'))
  details.appendChild(matchOptions)

  const taskTitles = collectHumanTaskTitles(
    app,
    options.taskFolderPath,
    options.excludePath,
  )
  let visibleTitles: string[] = []
  let activeIndex = -1

  const closeSuggestions = () => {
    suggestions.classList.add('is-hidden')
    suggestions.replaceChildren()
    visibleTitles = []
    activeIndex = -1
    titleInput.removeAttribute('aria-activedescendant')
  }

  const selectSuggestion = (title: string) => {
    titleInput.value = title
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    closeSuggestions()
    titleInput.focus()
  }

  const syncActiveSuggestion = () => {
    const rows = Array.from(
      suggestions.querySelectorAll<HTMLElement>('.obsidian-task-link-suggestion'),
    )
    rows.forEach((row, index) => {
      const active = index === activeIndex
      row.classList.toggle('is-active', active)
      row.setAttribute('aria-selected', active ? 'true' : 'false')
      if (active) titleInput.setAttribute('aria-activedescendant', row.id)
    })
  }

  const renderSuggestions = () => {
    const query = titleInput.value.trim().toLocaleLowerCase()
    visibleTitles = taskTitles
      .filter((title) => title.toLocaleLowerCase().includes(query))
      .slice(0, 12)
    suggestions.replaceChildren()
    activeIndex = -1
    if (visibleTitles.length === 0) {
      suggestions.classList.add('is-hidden')
      return
    }
    visibleTitles.forEach((title, index) => {
      const row = doc.win.createEl('button')
      row.type = 'button'
      row.id = `${radioName}-suggestion-${index}`
      row.className = 'obsidian-task-link-suggestion'
      row.textContent = title
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.addEventListener('mousedown', (event) => event.preventDefault())
      row.addEventListener('click', () => selectSuggestion(title))
      suggestions.appendChild(row)
    })
    suggestions.classList.remove('is-hidden')
  }

  const syncEnabled = () => {
    details.classList.toggle('is-hidden', !enabled.checked)
    if (!enabled.checked) closeSuggestions()
  }

  enabled.addEventListener('change', syncEnabled)
  titleInput.addEventListener('focus', renderSuggestions)
  titleInput.addEventListener('input', renderSuggestions)
  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSuggestions()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') {
      return
    }
    if (suggestions.classList.contains('is-hidden')) renderSuggestions()
    if (visibleTitles.length === 0) return
    event.preventDefault()
    if (event.key === 'ArrowDown') {
      activeIndex = (activeIndex + 1) % visibleTitles.length
      syncActiveSuggestion()
    } else if (event.key === 'ArrowUp') {
      activeIndex = (activeIndex - 1 + visibleTitles.length) % visibleTitles.length
      syncActiveSuggestion()
    } else if (activeIndex >= 0) {
      selectSuggestion(visibleTitles[activeIndex])
    }
  })

  const handleOutsidePointer = (event: Event) => {
    if (!root.contains(event.target as Node)) closeSuggestions()
  }
  doc.addEventListener('mousedown', handleOutsidePointer, true)
  syncEnabled()

  return {
    element: root,
    getValue: () => {
      if (!enabled.checked) return null
      const taskTitle = titleInput.value.trim()
      if (!taskTitle) return null
      const matchType = radios.get('contains')?.checked ? 'contains' : 'exact'
      return { enabled: true, taskTitle, matchType }
    },
    validate: () =>
      enabled.checked && titleInput.value.trim().length === 0
        ? translate('taskTitleRequired', 'Enter a matching task name.')
        : null,
    destroy: () => {
      doc.removeEventListener('mousedown', handleOutsidePointer, true)
      closeSuggestions()
    },
  }
}

function normalizeInitialValue(value: unknown): InitialValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { enabled: false, taskTitle: '', matchType: 'exact' }
  }
  const raw = value as Record<string, unknown>
  return {
    enabled: raw['enabled'] === true,
    taskTitle: typeof raw['taskTitle'] === 'string' ? raw['taskTitle'].trim() : '',
    matchType: raw['matchType'] === 'contains' ? 'contains' : 'exact',
  }
}

function collectHumanTaskTitles(
  app: App,
  taskFolderPath: string | undefined,
  excludePath?: string,
): string[] {
  const files = listFilesInFolder(app, taskFolderPath, { markdownOnly: true })
  const titles = new Set<string>()
  for (const file of files) {
    if (excludePath && file.path === excludePath) continue
    const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter
    if (frontmatter?.['ai_task'] === true) continue
    const title = resolveTaskDisplayTitle(frontmatter, file.basename)
    if (title) titles.add(title)
  }
  return Array.from(titles).sort((left, right) => left.localeCompare(right, 'ja'))
}
