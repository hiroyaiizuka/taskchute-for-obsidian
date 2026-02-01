/**
 * @jest-environment jsdom
 */

import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import RoutineEditModal from '../../src/features/routine/modals/RoutineEditModal'
import type { RoutineFrontmatter, TaskChutePluginLike } from '../../src/types'

jest.mock('obsidian')

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

const createApp = (frontmatter: RoutineFrontmatter): App =>
  ({
    metadataCache: {
      getFileCache: jest.fn(() => ({ frontmatter })),
    },
    fileManager: {
      processFrontMatter: jest.fn(),
    },
    workspace: {
      getLeavesOfType: jest.fn(() => []),
    },
  }) as unknown as App

const createPlugin = (): TaskChutePluginLike => ({}) as TaskChutePluginLike

describe('RoutineEditModal legacy frontmatter', () => {
  beforeAll(() => {
    ensureCreateEl()
  })

  beforeEach(() => {
    document.body.innerHTML = ''
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
    const fieldsets = monthlyGroup?.querySelectorAll('fieldset') ?? []
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
    const fieldsets = monthlyGroup?.querySelectorAll('fieldset') ?? []
    expect(fieldsets.length).toBeGreaterThanOrEqual(2)

    const weekFieldset = fieldsets[0]
    const weekdayFieldset = fieldsets[1]

    const weekFirst = weekFieldset.querySelector('input[value="1"]') as HTMLInputElement
    expect(weekFirst?.checked).toBe(true)

    const weekdayTue = weekdayFieldset.querySelector('input[value="2"]') as HTMLInputElement
    expect(weekdayTue?.checked).toBe(true)

    modal.close()
  })
})
