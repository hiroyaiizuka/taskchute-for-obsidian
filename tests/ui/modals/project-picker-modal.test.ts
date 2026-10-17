/**
 * @jest-environment jsdom
 */

import type { App, TFile } from 'obsidian'
import ProjectPickerModal from '@/ui/modals/ProjectPickerModal'
import type { TaskChutePluginLike } from '@/types'

const plugin = { settings: { projectTitlePrefix: 'Project - ' } } as unknown as TaskChutePluginLike
const files = [
  { path: 'Projects/Project - 引っ越し.md', basename: 'Project - 引っ越し' },
  { path: 'Projects/Project - ブログ記事.md', basename: 'Project - ブログ記事' },
] as TFile[]

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

async function openPicker(overrides: Partial<ConstructorParameters<typeof ProjectPickerModal>[1]> = {}) {
  const onSubmit = jest.fn<Promise<void>, [string]>(async () => {})
  const createProject = jest.fn(async (title: string) => `Projects/Project - ${title}.md`)
  const modal = new ProjectPickerModal({} as App, {
    tv: (_key, fallback, vars) => fallback.replace('{title}', String(vars?.title ?? '')),
    plugin,
    displayTitle: '記事を書く',
    projectFiles: files,
    currentProjectPath: null,
    onSubmit,
    createProject,
    ...overrides,
  })
  modal.open()
  await flush()
  const type = async (text: string) => {
    modal.inputEl.value = text
    modal.inputEl.dispatchEvent(new Event('input'))
    await flush()
  }
  const rows = () => Array.from(modal.resultContainerEl.querySelectorAll<HTMLElement>('.suggestion-item'))
  return { modal, onSubmit, createProject, type, rows }
}

describe('ProjectPickerModal', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-container').forEach((el) => el.remove())
  })

  test('lists the projects without the title prefix, and names the task in the field', async () => {
    const { modal, rows } = await openPicker()
    expect(modal.modalEl.classList).toContain('taskchute-project-picker')
    expect(modal.inputEl.placeholder).toContain('記事を書く')
    expect(rows().map((row) => row.textContent)).toEqual(['引っ越し', 'ブログ記事'])
  })

  test('picking a project links it', async () => {
    const { onSubmit, rows } = await openPicker()
    rows()[1].click()
    await flush()
    expect(onSubmit).toHaveBeenCalledWith('Projects/Project - ブログ記事.md')
  })

  test('a new name is created and linked in one step', async () => {
    const { onSubmit, createProject, type, rows } = await openPicker()
    await type('新企画')
    expect(rows().map((row) => row.textContent)).toEqual(['Create "新企画"'])
    expect(rows()[0].classList).toContain('is-create')
    rows()[0].click()
    await flush()
    expect(createProject).toHaveBeenCalledWith('新企画')
    expect(onSubmit).toHaveBeenCalledWith('Projects/Project - 新企画.md')
  })

  test('Enter picks the closest match when there is one; creating sits right below it', async () => {
    const { modal, onSubmit, createProject, type, rows } = await openPicker()
    await type('ブロ')
    expect(rows().map((row) => row.textContent)).toEqual(['ブログ記事', 'Create "ブロ"'])
    modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(createProject).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith('Projects/Project - ブログ記事.md')
  })

  test('Enter while a Japanese conversion is open does nothing', async () => {
    const { modal, onSubmit, createProject, type } = await openPicker()
    await type('しんきかく')
    modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
    await flush()
    expect(createProject).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('the linked project is marked, choosing it again changes nothing, and it can be removed', async () => {
    const { onSubmit, rows } = await openPicker({ currentProjectPath: 'Projects/Project - 引っ越し.md' })
    expect(rows().map((row) => row.textContent)).toEqual(['➖ Remove project', '引っ越し✓', 'ブログ記事'])
    rows()[1].click()
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()

    const again = await openPicker({ currentProjectPath: 'Projects/Project - 引っ越し.md' })
    again.rows()[0].click()
    await flush()
    expect(again.onSubmit).toHaveBeenCalledWith('')
  })

  test('closing writes nothing', async () => {
    const { modal, onSubmit, createProject, type } = await openPicker()
    await type('取り消すもの')
    modal.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(document.querySelector('.modal-container')).toBeNull()
    expect(createProject).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('with no project yet, the empty state says a name creates one', async () => {
    const { modal, type, rows } = await openPicker({ projectFiles: [] })
    expect(modal.resultContainerEl.textContent).toContain('Type a name to create one')
    await type('最初')
    expect(rows().map((row) => row.textContent)).toEqual(['Create "最初"'])
  })

  test('a failed creation links nothing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const { onSubmit, type, rows } = await openPicker({
      createProject: async () => {
        throw new Error('disk full')
      },
    })
    await type('壊れる')
    rows()[0].click()
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
