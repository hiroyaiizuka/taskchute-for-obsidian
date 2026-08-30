import { setIcon } from 'obsidian'
import { AiCustomModelStore } from '../../../src/features/ai-task/models/AiCustomModelStore'
import {
  AiModelSelectController,
  type AiModelSelectLabels,
} from '../../../src/features/ai-task/ui/AiModelSelectController'
import type { AiTaskHost } from '../../../src/features/ai-task/types'

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

const labels: AiModelSelectLabels = {
  openMenu: 'AI モデルを選択',
  defaultModel: 'デフォルトモデル',
  defaultDescription: 'CLI の設定を使用',
  builtInModels: '利用可能なモデル',
  customModels: 'カスタムモデル',
  addCustomModel: 'カスタムモデルを追加',
  editCustomModel: 'カスタムモデルを編集',
  deleteCustomModel: 'カスタムモデルを削除',
}

describe('AiModelSelectController', () => {
  let container: HTMLElement
  let store: AiCustomModelStore
  let controller: AiModelSelectController | null

  beforeEach(() => {
    document.body.replaceChildren()
    ;(setIcon as jest.MockedFunction<typeof setIcon>).mockClear()
    container = document.body.createDiv()
    store = new AiCustomModelStore()
    store.add('claude', {
      id: 'acme/claude-pro',
      label: 'Acme Claude Pro',
      description: '社内 Claude モデル',
    })
    store.add('codex', {
      id: 'acme/codex-pro',
      label: 'Acme Codex Pro',
      description: '社内 Codex モデル',
    })
    controller = null
  })

  afterEach(() => controller?.destroy())

  function create(
    host: AiTaskHost = 'claude',
    options: Partial<{
      modelId: string | null
      isCustom: boolean
      onChange: (modelId: string | null, isCustom: boolean) => void
    }> = {},
  ): AiModelSelectController {
    controller = new AiModelSelectController(container, {
      doc: document,
      host,
      store,
      labels,
      modelId: options.modelId,
      isCustom: options.isCustom,
      onChange: options.onChange,
    })
    return controller
  }

  function openMenu(): HTMLElement {
    ;(
      container.querySelector('.ai-model-select__trigger') as HTMLButtonElement
    ).click()
    return container.querySelector<HTMLElement>('.ai-model-select__menu')!
  }

  test('renders Default, host built-ins, host custom models, descriptions, and selection icons', () => {
    create('claude')
    const menu = openMenu()

    expect(menu.getAttribute('role')).toBe('listbox')
    expect(menu.querySelectorAll('.ai-model-select__option')).toHaveLength(6)
    expect(menu.textContent).toContain('Claude Fable 5')
    expect(menu.textContent).not.toContain('GPT-5.6 Sol')
    expect(menu.textContent).toContain('Acme Claude Pro')
    expect(menu.textContent).toContain('社内 Claude モデル')
    expect(menu.textContent).not.toContain('Acme Codex Pro')

    const defaultRow = menu.querySelector<HTMLElement>('[data-model-id=""]')
    expect(
      defaultRow?.querySelector('.ai-model-select__option-description')?.textContent,
    ).toBe('CLI の設定を使用')
    const builtIn = menu.querySelector<HTMLElement>(
      '[data-model-id="claude-fable-5"]',
    )
    expect(builtIn?.querySelector('.ai-model-select__option-description')).toBeNull()
    expect(builtIn?.textContent).toContain('Claude Fable 5')
    expect(builtIn?.textContent).not.toContain('claude-fable-5')

    const selected = menu.querySelector<HTMLElement>(
      '.ai-model-select__option[aria-selected="true"]',
    )
    expect(selected?.dataset.modelId).toBe('')
    expect(selected?.querySelector('[data-icon="circle-check"]')).not.toBeNull()
    expect(menu.querySelectorAll('.ai-model-select__edit')).toHaveLength(1)
    expect(menu.querySelectorAll('.ai-model-select__delete')).toHaveLength(1)
    expect(menu.querySelector('[data-model-id="claude-fable-5"] .ai-model-select__edit'))
      .toBeNull()
    expect(container.querySelector('[data-icon="cpu"]')).not.toBeNull()
    expect(container.querySelector('[data-icon="chevron-down"]')).not.toBeNull()
  })

  test('notifies modelId and isCustom for custom, built-in, and Default selections', () => {
    const onChange = jest.fn()
    const instance = create('claude', { onChange })

    openMenu().querySelector<HTMLButtonElement>(
      '.ai-model-select__option[data-model-id="acme/claude-pro"]',
    )!.click()
    expect(instance.getValue()).toEqual({
      modelId: 'acme/claude-pro',
      isCustom: true,
    })
    expect(onChange).toHaveBeenLastCalledWith('acme/claude-pro', true)
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent)
      .toBe('Acme Claude Pro')

    openMenu().querySelector<HTMLButtonElement>(
      '.ai-model-select__option[data-model-id="claude-fable-5"]',
    )!.click()
    expect(onChange).toHaveBeenLastCalledWith('claude-fable-5', false)

    openMenu().querySelector<HTMLButtonElement>(
      '.ai-model-select__option[data-model-id=""]',
    )!.click()
    expect(onChange).toHaveBeenLastCalledWith(null, false)
  })

  test('outside mousedown and Escape close the menu and restore trigger focus', () => {
    create()
    const trigger = container.querySelector<HTMLButtonElement>(
      '.ai-model-select__trigger',
    )!
    const menu = openMenu()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu.classList).not.toContain('is-hidden')

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(menu.classList).toContain('is-hidden')

    trigger.click()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(menu.classList).toContain('is-hidden')
    expect(document.activeElement).toBe(trigger)
  })

  test('opens upward with a bounded scroll area near the modal bottom', () => {
    const modal = document.body.createDiv({ cls: 'modal' })
    modal.appendChild(container)
    create()

    const trigger = container.querySelector<HTMLButtonElement>(
      '.ai-model-select__trigger',
    )!
    const menu = container.querySelector<HTMLElement>('.ai-model-select__menu')!
    jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(580, 618))
    jest.spyOn(modal, 'getBoundingClientRect').mockReturnValue(rect(400, 650))
    jest.spyOn(menu, 'getBoundingClientRect').mockReturnValue(rect(0, 340))

    trigger.click()

    expect(menu.classList).toContain('is-open-upward')
    expect(menu.style.maxHeight).toBe('176px')
  })

  test('adds a custom model at the end and automatically selects it', () => {
    const onChange = jest.fn()
    create('claude', { onChange })
    const menu = openMenu()
    ;(
      menu.querySelector('.ai-model-select__add') as HTMLButtonElement
    ).click()

    const id = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__model-id',
    )!
    const name = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__display-name',
    )!
    id.value = 'acme/claude-fast'
    name.value = 'Acme Fast'
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()

    expect(store.getCustomModels('claude').map((model) => model.id)).toEqual([
      'acme/claude-pro',
      'acme/claude-fast',
    ])
    expect(onChange).toHaveBeenCalledWith('acme/claude-fast', true)
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent)
      .toBe('Acme Fast')

    const reopened = openMenu()
    const customRows = reopened.querySelectorAll<HTMLElement>(
      '.ai-model-select__custom-row',
    )
    expect(customRows[customRows.length - 1]?.dataset.modelId)
      .toBe('acme/claude-fast')
    expect(
      customRows[customRows.length - 1]?.querySelector(
        '.ai-model-select__option-description',
      ),
    ).toBeNull()
    expect(customRows[customRows.length - 1]?.textContent)
      .not.toContain('acme/claude-fast')
  })

  test('edits only a custom model and keeps its immutable ID and selection', () => {
    const onChange = jest.fn()
    const instance = create('claude', {
      modelId: 'acme/claude-pro',
      isCustom: true,
      onChange,
    })
    const menu = openMenu()
    ;(
      menu.querySelector(
        '.ai-model-select__custom-row[data-model-id="acme/claude-pro"] .ai-model-select__edit',
      ) as HTMLButtonElement
    ).click()

    const id = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__model-id',
    )!
    const name = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__display-name',
    )!
    expect(id.disabled).toBe(true)
    expect(id.value).toBe('acme/claude-pro')
    name.value = 'Renamed model'
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()

    expect(store.getCustomModels('claude')[0]).toMatchObject({
      id: 'acme/claude-pro',
      label: 'Renamed model',
    })
    expect(instance.getValue()).toEqual({
      modelId: 'acme/claude-pro',
      isCustom: true,
    })
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent)
      .toBe('Renamed model')
    expect(onChange).not.toHaveBeenCalled()
  })

  test('deleting the selected custom model falls back to Default and notifies once', () => {
    const onChange = jest.fn()
    const instance = create('claude', {
      modelId: 'acme/claude-pro',
      isCustom: true,
      onChange,
    })
    const menu = openMenu()
    ;(
      menu.querySelector(
        '.ai-model-select__custom-row[data-model-id="acme/claude-pro"] .ai-model-select__delete',
      ) as HTMLButtonElement
    ).click()

    expect(store.getCustomModels('claude')).toEqual([])
    expect(instance.getValue()).toEqual({ modelId: null, isCustom: false })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(null, false)
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent)
      .toBe('デフォルトモデル')
  })

  test('setHost scopes custom choices and resets programmatic selection without notifying', () => {
    const onChange = jest.fn()
    const instance = create('claude', {
      modelId: 'acme/claude-pro',
      isCustom: true,
      onChange,
    })

    instance.setHost('codex')

    expect(instance.getValue()).toEqual({ modelId: null, isCustom: false })
    expect(onChange).not.toHaveBeenCalled()
    const menu = openMenu()
    expect(menu.textContent).toContain('GPT-5.6 Sol')
    expect(menu.textContent).toContain('Acme Codex Pro')
    expect(menu.textContent).not.toContain('Claude Fable 5')
    expect(menu.textContent).not.toContain('Acme Claude Pro')
  })

  test('destroy closes an owned modal, removes listeners, and removes owned DOM', () => {
    const instance = create()
    const menu = openMenu()
    ;(menu.querySelector('.ai-model-select__add') as HTMLButtonElement).click()
    expect(document.querySelector('.ai-custom-model-modal')).not.toBeNull()

    instance.destroy()
    controller = null

    expect(document.querySelector('.ai-custom-model-modal')).toBeNull()
    expect(container.querySelector('.ai-model-select')).toBeNull()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
})
