import { setIcon } from 'obsidian'
import { AiModelCatalog } from '@/features/ai-task/models/AiModelCatalog'
import type { AiListedModel } from '@/features/ai-task/agents/AiAgentDefinition'
import {
  AiModelSelectController,
  type AiModelSelectLabels,
  type AiModelSelectValue,
} from '@/features/ai-task/ui/AiModelSelectController'
import type { AiTaskHost } from '@/features/ai-task/types'

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
  }
}

const labels: AiModelSelectLabels = {
  openMenu: 'AI モデルを選択',
  defaultModel: 'デフォルトモデル',
  defaultDecidedBy: (host) => (host === 'claude' ? 'Claude Code が契約のプランに合わせて決める' : `${host} が決める`),
  refresh: '最新のモデルを取得',
  refreshing: '取得中…',
  fetchedAt: (time) => `${time} に取得`,
  neverFetched: 'まだ取得していません',
  fetching: '最新の一覧を取得中… このまま選べます',
  fetchFailed: (hasPrevious) => (hasPrevious ? '前回の一覧を出しています。' : 'プラグインに入っている一覧を出しています。'),
  newBadge: '新しい',
  alwaysNewest: 'それぞれ常に最新の版で動きます。一覧を取り直す必要はありません。',
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AiModelSelectController', () => {
  let container: HTMLElement
  let controller: AiModelSelectController | null
  let lists: AiListedModel[][]
  let pending: { resolve: (models: AiListedModel[]) => void; reject: (error: Error) => void } | null
  let defaults: Partial<Record<AiTaskHost, string>>
  let now: number

  beforeEach(() => {
    document.body.replaceChildren()
    ;(setIcon as jest.MockedFunction<typeof setIcon>).mockClear()
    container = document.body.createDiv()
    controller = null
    lists = []
    pending = null
    defaults = {}
    now = Date.UTC(2026, 9, 16, 3)
  })

  afterEach(() => controller?.destroy())

  function catalog(): AiModelCatalog {
    return new AiModelCatalog(
      {},
      () => {
        const next = lists.shift()
        if (next) return Promise.resolve(next)
        return new Promise((resolve, reject) => {
          pending = { resolve, reject }
        })
      },
      async (host) => defaults[host] ?? null,
      () => now,
    )
  }

  function create(
    host: AiTaskHost = 'claude',
    options: Partial<{
      catalog: AiModelCatalog
      modelId: string | null
      onChange: (value: AiModelSelectValue) => void
    }> = {},
  ): AiModelSelectController {
    controller = new AiModelSelectController(container, {
      doc: document,
      host,
      catalog: options.catalog ?? catalog(),
      labels,
      modelId: options.modelId,
      onChange: options.onChange,
      formatTime: () => '10/16 12:00',
    })
    return controller
  }

  function openMenu(): HTMLElement {
    container.querySelector<HTMLButtonElement>('.ai-model-select__trigger')!.click()
    return container.querySelector<HTMLElement>('.ai-model-select__menu')!
  }

  const menu = () => container.querySelector<HTMLElement>('.ai-model-select__menu')!
  const option = (id: string) =>
    menu().querySelector<HTMLButtonElement>(`.ai-model-select__option[data-model-id="${id}"]`)

  test('Claude Code: the default, then the aliases with their IDs, and no refresh', () => {
    create('claude')
    const opened = openMenu()

    expect(opened.querySelector('[role="listbox"]')).not.toBeNull()
    expect(Array.from(opened.querySelectorAll<HTMLElement>('.ai-model-select__option'), (row) => row.dataset.modelId))
      .toEqual(['', 'fable', 'opus', 'sonnet', 'haiku'])
    expect(option('')?.textContent).toContain('Claude Code が契約のプランに合わせて決める')
    expect(option('opus')?.querySelector('.ai-model-select__option-title')?.textContent).toBe('Claude Opus')
    expect(option('opus')?.querySelector('.ai-model-select__option-id')?.textContent).toBe('opus')
    expect(opened.querySelector('.ai-model-select__refresh')).toBeNull()
    expect(opened.querySelector('.ai-model-select__footer')?.textContent).toContain('常に最新の版')

    // Like Obsidian's menus: a check on the chosen row only.
    expect(option('')?.querySelector('[data-icon="check"]')).not.toBeNull()
    expect(option('opus')?.querySelector('.ai-model-select__selection-marker')).toBeNull()
    expect(container.querySelector('[data-icon="cpu"]')).not.toBeNull()
  })

  test('the default row names the model the CLI settings give', async () => {
    defaults.cursor = 'Auto'
    lists.push([{ id: 'composer-2.5', label: 'Composer 2.5' }])
    create('cursor')
    await flush()
    expect(container.querySelector('.ai-model-select__trigger-sub')?.textContent).toBe('Auto')
    expect(container.querySelector('.ai-model-select__trigger')?.classList).toContain('has-sub')
    expect(openMenu().querySelector('[data-model-id=""]')?.textContent).toContain('Auto')
  })

  test('opening fetches a missing list, shows it while fetching, then the time it was got', async () => {
    create('cursor')
    const opened = openMenu()
    expect(opened.querySelector('.ai-model-select__banner.is-fetching')?.textContent).toContain('取得中')
    expect(menu().querySelector<HTMLButtonElement>('.ai-model-select__refresh')?.disabled).toBe(true)

    pending!.resolve([{ id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5' }])
    await flush()

    expect(menu().querySelector('.ai-model-select__banner')).toBeNull()
    expect(option('claude-opus-5-5-medium')).not.toBeNull()
    expect(menu().querySelector('.ai-model-select__fetched-at')?.textContent).toBe('10/16 12:00 に取得')
    // The first list marks nothing new.
    expect(menu().querySelector('.ai-model-select__new')).toBeNull()
  })

  test('a failure keeps the built-in list and says so', async () => {
    create('codex')
    openMenu()
    pending!.reject(new Error('offline'))
    await flush()
    expect(menu().querySelector('.ai-model-select__banner.is-failed')?.textContent).toBe('プラグインに入っている一覧を出しています。')
    expect(option('gpt-5.6-sol')).not.toBeNull()
    expect(menu().querySelector('.ai-model-select__fetched-at')?.textContent).toBe('まだ取得していません')
  })

  test('the refresh button asks again; a model that appeared is new until chosen', async () => {
    const shared = catalog()
    lists.push([{ id: 'a-1', label: 'A' }], [{ id: 'a-1', label: 'A' }, { id: 'b-1', label: 'B' }])
    await shared.refresh('cursor')
    const onChange = jest.fn()
    create('cursor', { catalog: shared, onChange })
    openMenu()
    menu().querySelector<HTMLButtonElement>('.ai-model-select__refresh')!.click()
    await flush()

    expect(option('b-1')?.querySelector('.ai-model-select__new')?.textContent).toBe('新しい')
    expect(option('a-1')?.querySelector('.ai-model-select__new')).toBeNull()

    option('b-1')!.click()
    expect(onChange).toHaveBeenLastCalledWith({ modelId: 'b-1', isUnlisted: false })
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent).toBe('B')
    openMenu()
    expect(option('b-1')?.querySelector('.ai-model-select__new')).toBeNull()
  })

  test('reports the reasoning levels the list gives for the chosen model', async () => {
    const shared = catalog()
    lists.push([{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', reasoningLevels: ['low', 'ultra'] }])
    await shared.refresh('codex')
    const onChange = jest.fn()
    create('codex', { catalog: shared, onChange })
    openMenu()
    option('gpt-5.6-sol')!.click()
    expect(onChange).toHaveBeenLastCalledWith({
      modelId: 'gpt-5.6-sol',
      isUnlisted: false,
      reasoningLevels: ['low', 'ultra'],
    })
    openMenu()
    option('')!.click()
    expect(onChange).toHaveBeenLastCalledWith({ modelId: null, isUnlisted: false })
  })

  test("an older task's model the list does not have stays selected", () => {
    const instance = create('claude', { modelId: 'claude-opus-4-8' })
    expect(instance.getValue()).toEqual({ modelId: 'claude-opus-4-8', isUnlisted: true })
    expect(container.querySelector('.ai-model-select__trigger-label')?.textContent).toBe('claude-opus-4-8')
    expect(openMenu().querySelector('.ai-model-select__option[aria-selected="true"]')?.getAttribute('data-model-id'))
      .toBe('claude-opus-4-8')
  })

  test('a long ID is cut in the middle, keeping its end', () => {
    const instance = create('claude')
    instance.setValue('provider/some-very-long-model-name-high-fast')
    openMenu()
    const id = option('provider/some-very-long-model-name-high-fast')!.querySelector('.ai-model-select__option-id')!
    expect(id.getAttribute('title')).toBe('provider/some-very-long-model-name-high-fast')
    expect(id.querySelector('.ai-model-select__option-id-tail')?.textContent).toBe('me-high-fast')
  })

  test('outside mousedown and Escape close the menu and restore trigger focus', () => {
    create()
    openMenu()
    expect(container.querySelector('.ai-model-select__trigger')?.getAttribute('aria-expanded')).toBe('true')

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(menu().classList).toContain('is-hidden')

    openMenu()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu().classList).toContain('is-hidden')
    expect(document.activeElement).toBe(container.querySelector('.ai-model-select__trigger'))
  })

  test('opens upward with a bounded scroll area near the modal bottom', () => {
    const modal = document.body.createDiv({ cls: 'modal' })
    modal.appendChild(container)
    create()

    const trigger = container.querySelector<HTMLButtonElement>('.ai-model-select__trigger')!
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === modal) return rect(400, 650)
      if (this.classList.contains('ai-model-select__trigger')) return rect(580, 618)
      return rect(0, 340)
    })

    trigger.click()

    expect(menu().classList).toContain('is-open-upward')
    expect(menu().style.maxHeight).toBe('176px')
    jest.restoreAllMocks()
  })

  test('setHost shows the other agent and resets the selection without notifying', () => {
    const onChange = jest.fn()
    const instance = create('claude', { modelId: 'opus', onChange })
    lists.push([{ id: 'composer-2.5', label: 'Composer 2.5' }])
    instance.setHost('codex')

    expect(instance.getValue()).toEqual({ modelId: null, isUnlisted: false })
    expect(onChange).not.toHaveBeenCalled()
    expect(openMenu().textContent).toContain('GPT-5.6 Sol')
    expect(menu().textContent).not.toContain('Claude Opus')
  })

  test('destroy removes its DOM and stops listening', () => {
    const shared = catalog()
    const instance = create('cursor', { catalog: shared })
    instance.destroy()
    controller = null
    expect(container.querySelector('.ai-model-select')).toBeNull()
    void shared.refresh('cursor')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(container.querySelector('.ai-model-select')).toBeNull()
  })
})
