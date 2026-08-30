import { setIcon } from 'obsidian'
import { WorkingDirectoryHistory } from '../../../src/features/ai-task/services/WorkingDirectoryHistory'
import type { ElectronDirectoryPicker } from '../../../src/features/ai-task/services/ElectronDirectoryPicker'
import {
  WorkingDirectorySelectController,
  type WorkingDirectorySelectLabels,
} from '../../../src/features/ai-task/ui/WorkingDirectorySelectController'

const labels: WorkingDirectorySelectLabels = {
  browse: 'フォルダを選択',
  defaultBadge: 'デフォルト',
  recentHeader: '最近使用したディレクトリ',
  resetDefault: 'デフォルトに戻す',
  placeholder: '/path/to/workspace',
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 500,
    bottom,
    left: 0,
    width: 500,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

describe('WorkingDirectorySelectController', () => {
  let container: HTMLElement
  let history: WorkingDirectoryHistory
  let picker: Pick<ElectronDirectoryPicker, 'selectDirectory'>
  let selectDirectory: jest.MockedFunction<(path?: string) => Promise<string | null>>
  let controller: WorkingDirectorySelectController | null

  beforeEach(() => {
    document.body.replaceChildren()
    ;(setIcon as jest.MockedFunction<typeof setIcon>).mockClear()
    container = document.body.createDiv()
    history = new WorkingDirectoryHistory({
      loadLocalStorage: () => ['/recent/alpha', '/recent/beta'],
      saveLocalStorage: jest.fn(),
    })
    selectDirectory = jest.fn(async () => null)
    picker = { selectDirectory }
    controller = null
  })

  afterEach(() => controller?.destroy())

  function create(
    options: Partial<{
      value: string
      defaultDirectory: string
      candidateDirectories: string[]
      onChange: (value: string) => void
      selectedHistory: WorkingDirectoryHistory
    }> = {},
  ): WorkingDirectorySelectController {
    controller = new WorkingDirectorySelectController(container, {
      value: options.value ?? '/recent/alpha',
      defaultDirectory: options.defaultDirectory ?? '/Users/me/Evergreens',
      candidateDirectories: options.candidateDirectories ?? ['/candidate/project'],
      history: options.selectedHistory ?? history,
      picker,
      labels,
      onChange: options.onChange,
    })
    return controller
  }

  test('renders an editable input, history chevron, and an always-visible Browse button', () => {
    create()

    const input = container.querySelector<HTMLInputElement>(
      '.ai-working-directory-select__input',
    )
    expect(input?.value).toBe('/recent/alpha')
    expect(input?.readOnly).toBe(false)
    expect(input?.placeholder).toBe('/Users/me/Evergreens')
    expect(container.querySelector('.ai-working-directory-select__toggle')).not.toBeNull()
    const browse = container.querySelector<HTMLButtonElement>(
      '.ai-working-directory-select__browse',
    )
    expect(browse?.getAttribute('aria-label')).toBe('フォルダを選択')
    expect(setIcon).toHaveBeenCalledWith(browse, 'folder')
  })

  test('hides the chevron when no recent directory exists but keeps Browse and reset', () => {
    const emptyHistory = new WorkingDirectoryHistory({
      loadLocalStorage: () => [],
      saveLocalStorage: jest.fn(),
    })
    create({
      value: '/custom',
      candidateDirectories: [],
      selectedHistory: emptyHistory,
    })

    expect(container.querySelector('.ai-working-directory-select__toggle')).toBeNull()
    expect(container.querySelector('.ai-working-directory-select__browse')).not.toBeNull()
    expect(container.querySelector('.ai-working-directory-select__reset')).not.toBeNull()
  })

  test('shows default and two-line recent rows with the current row selected', () => {
    create()
    ;(
      container.querySelector(
        '.ai-working-directory-select__toggle',
      ) as HTMLButtonElement
    ).click()

    const menu = container.querySelector<HTMLElement>(
      '.ai-working-directory-select__menu',
    )
    expect(menu?.classList).not.toContain('is-hidden')
    const defaultRow = menu?.querySelector<HTMLElement>(
      '.ai-working-directory-select__option--default',
    )
    expect(defaultRow?.textContent).toContain('Evergreens')
    expect(defaultRow?.textContent).toContain('/Users/me/Evergreens')
    expect(defaultRow?.textContent).toContain('デフォルト')
    expect(defaultRow?.querySelector('[data-icon="home"]')).not.toBeNull()
    expect(menu?.querySelector('.ai-working-directory-select__recent-header')?.textContent)
      .toContain('最近使用したディレクトリ')

    const selected = menu?.querySelector<HTMLElement>(
      '.ai-working-directory-select__option[aria-selected="true"]',
    )
    expect(selected?.dataset.path).toBe('/recent/alpha')
    expect(selected?.classList).toContain('is-selected')
    const alpha = selected?.querySelector('.ai-working-directory-select__option-title')
    const alphaParent = selected?.querySelector(
      '.ai-working-directory-select__option-parent',
    )
    expect(alpha?.textContent).toBe('alpha')
    expect(alphaParent?.textContent).toBe('/recent')
  })

  test('anchors the scrollable menu to the input and opens upward inside the modal boundary', () => {
    const modal = document.body.createDiv({ cls: 'modal' })
    modal.appendChild(container)
    create()

    const wrapper = container.querySelector<HTMLElement>(
      '.ai-working-directory-select__input-wrapper',
    )!
    const menu = container.querySelector<HTMLElement>(
      '.ai-working-directory-select__menu',
    )!
    const toggle = container.querySelector<HTMLButtonElement>(
      '.ai-working-directory-select__toggle',
    )!
    expect(wrapper.contains(menu)).toBe(true)

    jest.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(rect(580, 618))
    jest.spyOn(modal, 'getBoundingClientRect').mockReturnValue(rect(400, 650))
    jest.spyOn(menu, 'getBoundingClientRect').mockReturnValue(rect(0, 300))

    toggle.click()

    expect(menu.classList).toContain('is-open-upward')
    expect(menu.style.maxHeight).toBe('176px')
  })

  test('manual input updates value, row selection, reset visibility, and onChange', () => {
    const onChange = jest.fn()
    const instance = create({ onChange })
    const input = container.querySelector<HTMLInputElement>(
      '.ai-working-directory-select__input',
    )!

    input.value = '/Users/me/Evergreens/'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(instance.getValue()).toBe('/Users/me/Evergreens/')
    expect(onChange).toHaveBeenCalledWith('/Users/me/Evergreens/')
    expect(
      container.querySelector('.ai-working-directory-select__reset')?.classList,
    ).toContain('is-hidden')
    expect(
      container.querySelector(
        '.ai-working-directory-select__option--default',
      )?.getAttribute('aria-selected'),
    ).toBe('true')
  })

  test('selecting a history row updates the input and closes the menu', () => {
    const onChange = jest.fn()
    const instance = create({ value: '', onChange })
    ;(
      container.querySelector(
        '.ai-working-directory-select__toggle',
      ) as HTMLButtonElement
    ).click()
    ;(
      container.querySelector(
        '.ai-working-directory-select__option[data-path="/recent/beta"]',
      ) as HTMLButtonElement
    ).click()

    expect(instance.getValue()).toBe('/recent/beta')
    expect(onChange).toHaveBeenCalledWith('/recent/beta')
    expect(
      container.querySelector('.ai-working-directory-select__menu')?.classList,
    ).toContain('is-hidden')
  })

  test('Browse starts at current then default, reflects selection, and defers history commit', async () => {
    const saveLocalStorage = jest.fn()
    const selectedHistory = new WorkingDirectoryHistory({
      loadLocalStorage: () => [],
      saveLocalStorage,
    })
    const instance = create({
      value: '/current',
      candidateDirectories: [],
      selectedHistory,
    })
    selectDirectory.mockResolvedValueOnce('/picked/project')

    ;(
      container.querySelector(
        '.ai-working-directory-select__browse',
      ) as HTMLButtonElement
    ).click()
    await flushAsync()

    expect(selectDirectory).toHaveBeenCalledWith('/current')
    expect(instance.getValue()).toBe('/picked/project')
    expect(saveLocalStorage).not.toHaveBeenCalled()

    const input = container.querySelector<HTMLInputElement>(
      '.ai-working-directory-select__input',
    )!
    input.value = '   '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await instance.browse()
    expect(selectDirectory).toHaveBeenLastCalledWith('/Users/me/Evergreens')

    input.value = '/picked/project'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(instance.commitHistory()).toEqual(['/picked/project'])
    expect(saveLocalStorage).toHaveBeenCalled()
  })

  test('reset restores default and commitHistory skips it', () => {
    const saveLocalStorage = jest.fn()
    const selectedHistory = new WorkingDirectoryHistory({
      loadLocalStorage: () => [],
      saveLocalStorage,
    })
    const instance = create({
      value: '/custom',
      candidateDirectories: [],
      selectedHistory,
    })

    ;(
      container.querySelector(
        '.ai-working-directory-select__reset',
      ) as HTMLButtonElement
    ).click()

    expect(instance.getValue()).toBe('/Users/me/Evergreens')
    expect(instance.commitHistory()).toEqual([])
    expect(saveLocalStorage).not.toHaveBeenCalled()
  })

  test('outside mousedown and Escape close the menu; destroy removes owned DOM', () => {
    const instance = create()
    const toggle = container.querySelector<HTMLButtonElement>(
      '.ai-working-directory-select__toggle',
    )!
    const menu = container.querySelector<HTMLElement>(
      '.ai-working-directory-select__menu',
    )!

    toggle.click()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(menu.classList).toContain('is-hidden')

    toggle.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.classList).toContain('is-hidden')
    expect(document.activeElement).toBe(toggle)

    instance.destroy()
    controller = null
    expect(container.querySelector('.ai-working-directory-select')).toBeNull()
  })

  test('ignores an async Browse result after destroy', async () => {
    let resolveSelection!: (path: string | null) => void
    selectDirectory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve
        }),
    )
    const onChange = jest.fn()
    const instance = create({ onChange })

    const pending = instance.browse()
    instance.destroy()
    controller = null
    resolveSelection('/late/path')
    await pending

    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('.ai-working-directory-select')).toBeNull()
  })
})
