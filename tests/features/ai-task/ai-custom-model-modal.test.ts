import { setIcon } from 'obsidian'
import { AiCustomModelStore } from '../../../src/features/ai-task/models/AiCustomModelStore'
import {
  AiCustomModelModal,
  type AiCustomModelModalLabels,
} from '../../../src/features/ai-task/ui/AiCustomModelModal'

const labels: AiCustomModelModalLabels = {
  addTitle: 'カスタムモデルを追加',
  editTitle: 'カスタムモデルを編集',
  claudeAgent: 'Claude Code',
  codexAgent: 'Codex',
  modelId: 'モデル ID',
  modelIdPlaceholder: 'provider/model-name',
  modelIdHelp: 'CLI に渡すモデル ID',
  displayName: '表示名',
  displayNamePlaceholder: 'チームモデル',
  description: '説明',
  descriptionPlaceholder: '任意の説明',
  commandPreview: 'コマンドプレビュー',
  cancel: 'キャンセル',
  add: '追加',
  save: '保存',
  close: '閉じる',
  invalidId: '安全なモデル ID を入力してください',
  duplicateId: 'このモデル ID は既に存在します',
  invalidLabel: '表示名を入力してください',
  invalidDescription: '説明が正しくありません',
  modelNotFound: 'モデルが見つかりません',
}

describe('AiCustomModelModal', () => {
  let store: AiCustomModelStore
  let modal: AiCustomModelModal | null

  beforeEach(() => {
    document.body.replaceChildren()
    ;(setIcon as jest.MockedFunction<typeof setIcon>).mockClear()
    store = new AiCustomModelStore()
    modal = null
  })

  afterEach(() => modal?.close())

  test('adds a validated model, previews the literal flag, and reports the saved model', () => {
    const onSaved = jest.fn()
    modal = new AiCustomModelModal({
      app: {} as never,
      host: 'claude',
      store,
      labels,
      onSaved,
    })
    modal.open()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('.ai-custom-model-modal__agent')?.textContent)
      .toContain('Claude Code')

    const id = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__model-id',
    )!
    const name = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__display-name',
    )!
    const description = document.querySelector<HTMLTextAreaElement>(
      '.ai-custom-model-modal__description',
    )!
    id.value = 'acme/claude-pro'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    name.value = 'Acme Pro'
    description.value = '社内プロバイダー'

    expect(document.querySelector('.ai-custom-model-modal__preview')?.textContent)
      .toContain('--model=acme/claude-pro')
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()

    expect(store.getCustomModels('claude')).toEqual([
      {
        id: 'acme/claude-pro',
        label: 'Acme Pro',
        description: '社内プロバイダー',
      },
    ])
    expect(onSaved).toHaveBeenCalledWith({
      id: 'acme/claude-pro',
      label: 'Acme Pro',
      description: '社内プロバイダー',
    })
    expect(document.querySelector('.ai-custom-model-modal')).toBeNull()
  })

  test('keeps the modal open and shows actionable validation errors', () => {
    const onSaved = jest.fn()
    modal = new AiCustomModelModal({
      app: {} as never,
      host: 'claude',
      store,
      labels,
      onSaved,
    })
    modal.open()

    const id = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__model-id',
    )!
    const name = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__display-name',
    )!
    id.value = '--danger'
    name.value = 'Danger'
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()

    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('安全なモデル ID を入力してください')
    expect(id.getAttribute('aria-invalid')).toBe('true')
    expect(onSaved).not.toHaveBeenCalled()

    id.value = 'claude-fable-5'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('このモデル ID は既に存在します')

    id.value = 'valid-model'
    name.value = '   '
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('表示名を入力してください')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('.ai-custom-model-modal')).not.toBeNull()
  })

  test('edits label and description while keeping the model ID fixed', () => {
    store.add('codex', {
      id: 'acme/sol-pro',
      label: 'Old label',
      description: 'Old description',
    })
    const onSaved = jest.fn()
    modal = new AiCustomModelModal({
      app: {} as never,
      host: 'codex',
      store,
      labels,
      editModel: store.getCustomModels('codex')[0],
      onSaved,
    })
    modal.open()

    const id = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__model-id',
    )!
    expect(id.value).toBe('acme/sol-pro')
    expect(id.disabled).toBe(true)
    expect(document.querySelector('.modal-title')?.textContent)
      .toBe('カスタムモデルを編集')

    const name = document.querySelector<HTMLInputElement>(
      '.ai-custom-model-modal__display-name',
    )!
    const description = document.querySelector<HTMLTextAreaElement>(
      '.ai-custom-model-modal__description',
    )!
    name.value = 'New label'
    description.value = ''
    ;(
      document.querySelector('.ai-custom-model-modal__submit') as HTMLButtonElement
    ).click()

    expect(store.getCustomModels('codex')).toEqual([
      { id: 'acme/sol-pro', label: 'New label' },
    ])
    expect(onSaved).toHaveBeenCalledWith({
      id: 'acme/sol-pro',
      label: 'New label',
    })
  })

  test('backdrop and close button dismiss without saving', () => {
    const onClosed = jest.fn()
    modal = new AiCustomModelModal({
      app: {} as never,
      host: 'claude',
      store,
      labels,
      onClosed,
    })
    // Escape is Obsidian's own scope now and is covered by the platform; what
    // stays worth pinning is that dismissing never saves.
    modal.open()
    expect(document.querySelector('.ai-custom-model-modal')).not.toBeNull()
    document.querySelector<HTMLElement>('.modal-bg')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.ai-custom-model-modal')).toBeNull()
    expect(onClosed).toHaveBeenCalledTimes(1)

    modal.open()
    document.querySelector<HTMLElement>('.modal-close-button')!.click()
    expect(document.querySelector('.ai-custom-model-modal')).toBeNull()
    expect(onClosed).toHaveBeenCalledTimes(2)
    expect(store.getCustomModels('claude')).toEqual([])
  })
})
