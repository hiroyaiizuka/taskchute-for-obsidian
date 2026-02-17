/**
 * @jest-environment jsdom
 */

import { Notice, TFile } from 'obsidian'
import type { App } from 'obsidian'
import RoutineEditModal from '../../src/features/routine/modals/RoutineEditModal'
import type { RoutineFrontmatter, TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian')

const NoticeMock = Notice as unknown as jest.Mock

const ensureCreateEl = () => {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: (
      tag: string,
      options?: {
        cls?: string
        text?: string
        attr?: Record<string, string | number | boolean>
        type?: string
        value?: string
      },
    ) => HTMLElement
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options = {}) {
      const element = document.createElement(tag)
      if (options.cls) {
        element.classList.add(...options.cls.split(' ').filter(Boolean))
      }
      if (options.text !== undefined) {
        element.textContent = String(options.text)
      }
      if (options.type) {
        ;(element as HTMLInputElement).type = options.type
      }
      if (options.value !== undefined) {
        ;(element as HTMLInputElement).value = String(options.value)
      }
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          element.setAttribute(key, String(value))
        })
      }
      this.appendChild(element)
      return element
    }
  }
}

const createFile = (path: string): TFile => {
  const file = new TFile(path)
  const proto = (TFile as unknown as { prototype?: unknown }).prototype ?? Object.getPrototypeOf(file)
  if (Object.getPrototypeOf(file) !== proto && proto) {
    Object.setPrototypeOf(file, proto)
  }
  if (typeof (file as { constructor?: unknown }).constructor !== 'function') {
    ;(file as { constructor?: unknown }).constructor = TFile
  }
  return file
}

const createApp = (
  frontmatter: RoutineFrontmatter,
  options?: { currentDate?: Date; viewDates?: Date[]; activeLeafIndex?: number },
): App =>
  (() => {
    const viewDates = options?.viewDates ?? [options?.currentDate ?? new Date(2025, 10, 30)]
    const leaves = viewDates.map((currentDate) => ({
      view: {
        currentDate,
        reloadTasksAndRestore: jest.fn(async () => {}),
      },
    }))
    const activeLeaf = leaves[options?.activeLeafIndex ?? 0] ?? leaves[0]

    return {
    metadataCache: {
      getFileCache: jest.fn(() => ({ frontmatter })),
    },
    fileManager: {
      processFrontMatter: jest.fn(
        async (_file: TFile, updater: (fm: RoutineFrontmatter) => RoutineFrontmatter) => {
          updater(frontmatter)
        },
      ),
    },
    workspace: {
      getLeavesOfType: jest.fn(() => leaves),
      getMostRecentLeaf: jest.fn(() => activeLeaf),
    },
  } as unknown as App
  })()

const createPlugin = (): TaskChutePluginLike => ({}) as TaskChutePluginLike

describe('RoutineEditModal legacy frontmatter', () => {
  beforeAll(() => {
    ensureCreateEl()
  })

  beforeEach(() => {
    document.body.innerHTML = ''
    NoticeMock.mockClear()
  })

  it('prefills legacy monthly weeks and weekdays arrays', () => {
    const frontmatter: RoutineFrontmatter = {
      routine_type: 'monthly',
      monthly_weeks: [0, 2, 'last'],
      monthly_weekdays: [1, 4],
    }
    const app = createApp(frontmatter)
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()
    const monthlyGroup = overlay?.querySelector('.routine-form__monthly')
    expect(monthlyGroup).not.toBeNull()
    const fieldsets = monthlyGroup?.querySelectorAll('.routine-chip-fieldset') ?? []
    expect(fieldsets.length).toBeGreaterThanOrEqual(2)

    const weekFieldset = fieldsets[0]
    const weekdayFieldset = fieldsets[1]

    const weekFirst = weekFieldset.querySelector('input[value="1"]') as HTMLInputElement
    const weekThird = weekFieldset.querySelector('input[value="3"]') as HTMLInputElement
    const weekLast = weekFieldset.querySelector('input[value="last"]') as HTMLInputElement
    expect(weekFirst?.checked).toBe(true)
    expect(weekThird?.checked).toBe(true)
    expect(weekLast?.checked).toBe(true)

    const weekdayMon = weekdayFieldset.querySelector('input[value="1"]') as HTMLInputElement
    const weekdayThu = weekdayFieldset.querySelector('input[value="4"]') as HTMLInputElement
    expect(weekdayMon?.checked).toBe(true)
    expect(weekdayThu?.checked).toBe(true)

    modal.close()
  })

  it('converts legacy zero-based monthly_week to 1-based selection', () => {
    const frontmatter: RoutineFrontmatter = {
      routine_type: 'monthly',
      monthly_week: 0,
      monthly_weekday: 2,
    }
    const app = createApp(frontmatter)
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()
    const monthlyGroup = overlay?.querySelector('.routine-form__monthly')
    expect(monthlyGroup).not.toBeNull()
    const fieldsets = monthlyGroup?.querySelectorAll('.routine-chip-fieldset') ?? []
    expect(fieldsets.length).toBeGreaterThanOrEqual(2)

    const weekFieldset = fieldsets[0]
    const weekdayFieldset = fieldsets[1]

    const weekFirst = weekFieldset.querySelector('input[value="1"]') as HTMLInputElement
    expect(weekFirst?.checked).toBe(true)

    const weekdayTue = weekdayFieldset.querySelector('input[value="2"]') as HTMLInputElement
    expect(weekdayTue?.checked).toBe(true)

    modal.close()
  })

  it('closes monthly date dropdown when clicking outside selector within modal', () => {
    const frontmatter: RoutineFrontmatter = {
      routine_type: 'monthly_date',
    }
    const app = createApp(frontmatter)
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()

    const trigger = overlay?.querySelector('.routine-monthday-trigger') as HTMLButtonElement
    const dropdown = overlay?.querySelector('.routine-monthday-dropdown') as HTMLDivElement
    const outsideInModal = overlay?.querySelector('.routine-form') as HTMLElement

    expect(trigger).toBeTruthy()
    expect(dropdown.classList.contains('is-hidden')).toBe(true)

    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dropdown.classList.contains('is-hidden')).toBe(false)

    outsideInModal.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dropdown.classList.contains('is-hidden')).toBe(true)

    modal.close()
  })

  it('uses current view date as target_date when disabling routine on save', async () => {
    const frontmatter: RoutineFrontmatter = {
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
    }
    const app = createApp(frontmatter, {
      currentDate: new Date(2025, 11, 24),
    })
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()

    const enabledToggle = overlay?.querySelector('.form-group--inline input[type="checkbox"]') as HTMLInputElement
    const saveButton = overlay?.querySelector('.routine-editor__button--primary') as HTMLButtonElement
    expect(enabledToggle).toBeTruthy()
    expect(saveButton).toBeTruthy()

    enabledToggle.checked = false
    saveButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(frontmatter.routine_enabled).toBe(false)
    expect((frontmatter as Record<string, unknown>).target_date).toBe('2025-12-24')
  })

  it('preserves existing target_date when saving already-disabled routine', async () => {
    const frontmatter: RoutineFrontmatter = {
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: false,
      target_date: '2026-01-15',
    }
    const app = createApp(frontmatter, {
      currentDate: new Date(2025, 11, 24),
    })
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()

    const saveButton = overlay?.querySelector('.routine-editor__button--primary') as HTMLButtonElement
    expect(saveButton).toBeTruthy()

    saveButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(frontmatter.routine_enabled).toBe(false)
    expect((frontmatter as Record<string, unknown>).target_date).toBe('2026-01-15')
    expect(NoticeMock).not.toHaveBeenCalledWith(
      'Removed legacy target_date automatically.',
    )
  })

  it('uses active taskchute view date when multiple taskchute leaves are open', async () => {
    const frontmatter: RoutineFrontmatter = {
      isRoutine: true,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
    }
    const app = createApp(frontmatter, {
      viewDates: [new Date(2025, 10, 30), new Date(2025, 11, 1)],
      activeLeafIndex: 1,
    })
    const modal = new RoutineEditModal(app, createPlugin(), createFile('TASKS/sample.md'))

    modal.open()

    const overlay = document.body.querySelector('.task-modal-overlay')
    expect(overlay).not.toBeNull()

    const enabledToggle = overlay?.querySelector('.form-group--inline input[type="checkbox"]') as HTMLInputElement
    const saveButton = overlay?.querySelector('.routine-editor__button--primary') as HTMLButtonElement
    expect(enabledToggle).toBeTruthy()
    expect(saveButton).toBeTruthy()

    enabledToggle.checked = false
    saveButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(frontmatter.routine_enabled).toBe(false)
    expect((frontmatter as Record<string, unknown>).target_date).toBe('2025-12-01')
  })
})
