import { Notice, TFile } from 'obsidian'
import type { TaskInstance } from '../../../src/types'
import ScheduledTimeModal from '../../../src/ui/modals/ScheduledTimeModal'

// The shared mock builds Obsidian's real modal markup, so this suite no longer
// needs a hand-rolled Modal with DOM-helper shims.
jest.mock('obsidian', () => {
  const { Modal, ButtonComponent } = jest.requireActual('obsidian')
  return {
    App: class MockApp {},
    Modal,
    ButtonComponent,
    Notice: jest.fn(),
    TFile: class MockTFile {},
  }
})

jest.mock('../../../src/utils/fieldMigration', () => {
  return {
    getScheduledTime: jest.fn(() => '08:30'),
    setScheduledTime: jest.fn(),
  }
})

const { getScheduledTime, setScheduledTime } = jest.requireMock('../../../src/utils/fieldMigration')

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ScheduledTimeModal', () => {
  const createHost = () => {
    const file = new TFile()
    return {
      tv: (_key: string, fallback: string, vars?: Record<string, string | number>) => {
        if (vars && vars.time) {
          return fallback.replace('{time}', String(vars.time))
        }
        return fallback
      },
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(() => file),
          read: jest.fn(),
        },
        fileManager: {
          processFrontMatter: jest.fn(async (_: TFile, updater: (frontmatter: Record<string, unknown>) => void) => {
            const fm: Record<string, unknown> = {}
            updater(fm)
          }),
        },
      },
      reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
    }
  }

  const createInstance = (): TaskInstance => ({
    task: {
      path: 'Tasks/sample.md',
      frontmatter: {},
      name: 'sample',
    },
  } as TaskInstance)

  beforeEach(() => {
    ;(Notice as unknown as jest.Mock).mockClear()
    getScheduledTime.mockClear()
    setScheduledTime.mockClear()
    document.body.innerHTML = ''
  })

  test('initializes input with scheduled time and saves new value', async () => {
    const host = createHost()
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    expect(input.value).toBe('08:30')

    input.value = '09:15'
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(host.app.vault.getAbstractFileByPath).toHaveBeenCalledWith('Tasks/sample.md')
    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(setScheduledTime).toHaveBeenCalledWith(expect.any(Object), '09:15', { preferNew: true })
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
    expect(Notice).toHaveBeenCalled()
    expect(document.querySelector('.scheduled-time-modal')).toBeNull()
  })

  test('calls onScheduledTimeSaved with previous and next scheduled time', async () => {
    const host = createHost()
    const onScheduledTimeSaved = jest.fn().mockResolvedValue(undefined)
    Object.assign(host, { onScheduledTimeSaved })
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    input.value = '09:15'
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(onScheduledTimeSaved).toHaveBeenCalledWith(instance, {
      previousScheduledTime: '08:30',
      nextScheduledTime: '09:15',
    })
  })

  test('uses host saveScheduledTime and skips frontmatter when handled', async () => {
    const host = createHost()
    const saveScheduledTime = jest.fn().mockResolvedValue(true)
    const onScheduledTimeSaved = jest.fn().mockResolvedValue(undefined)
    Object.assign(host, { saveScheduledTime, onScheduledTimeSaved })
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    input.value = '09:15'
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(saveScheduledTime).toHaveBeenCalledWith(instance, '09:15', {
      previousScheduledTime: '08:30',
      nextScheduledTime: '09:15',
    })
    expect(host.app.vault.getAbstractFileByPath).not.toHaveBeenCalled()
    expect(host.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
    expect(onScheduledTimeSaved).toHaveBeenCalledWith(instance, {
      previousScheduledTime: '08:30',
      nextScheduledTime: '09:15',
    })
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
  })

  test('clearing value removes scheduled time', async () => {
    const host = createHost()
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const input = document.querySelector('.scheduled-time-form input[type="time"]') as HTMLInputElement
    input.value = ''
    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(setScheduledTime).toHaveBeenCalledWith(expect.any(Object), undefined, { preferNew: true })
  })

  test('shows notice when task file is missing', async () => {
    const host = createHost()
    host.app.vault.getAbstractFileByPath = jest.fn(
      () => null,
    ) as unknown as typeof host.app.vault.getAbstractFileByPath
    const instance = createInstance()
    const modal = new ScheduledTimeModal({ host, instance })

    modal.open()

    const form = document.querySelector('.scheduled-time-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(Notice).toHaveBeenCalled()
    expect(host.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
  })
})
