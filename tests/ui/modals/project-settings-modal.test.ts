/**
 * @jest-environment jsdom
 */

import type { App } from 'obsidian'
import ProjectSettingsModal from '../../../src/ui/modals/ProjectSettingsModal'
import type { TaskChutePluginLike } from '../../../src/types'

const plugin = {
  settings: {
    projectTitlePrefix: 'Project - ',
  },
} as unknown as TaskChutePluginLike

function openModal(
  overrides: Partial<ConstructorParameters<typeof ProjectSettingsModal>[1]> = {},
): ProjectSettingsModal {
  const app = {} as App
  const modal = new ProjectSettingsModal(app, {
    app,
    plugin,
    tv: (_key, fallback) => fallback,
    displayTitle: 'Sample',
    projectFiles: [],
    currentProjectPath: undefined,
    onSubmit: async () => {},
    ...overrides,
  })
  modal.open()
  return modal
}

describe('ProjectSettingsModal', () => {
  afterEach(() => {
    document.querySelectorAll('.modal-container').forEach((el) => el.remove())
  })

  test('opens in the standard Obsidian modal shell', () => {
    const modal = openModal()

    expect(document.body.querySelector('.modal-container')).toBe(modal.containerEl)
    expect(modal.titleEl.textContent).toContain('Sample')

    modal.close()
    expect(document.body.querySelector('.modal-container')).toBeNull()
  })

  test('shows empty-state message without mentioning #project tag', () => {
    const modal = openModal({ projectFiles: [] })

    const text = modal.contentEl.textContent || ''
    expect(text).toContain('No project files found')
    expect(text).not.toContain('#project')

    modal.close()
  })

  test('offers each project plus a blank entry, and saves the picked one', async () => {
    const saved: string[] = []
    const modal = openModal({
      projectFiles: [
        { path: 'Projects/Project - Alpha.md', basename: 'Project - Alpha' },
        { path: 'Projects/Project - Beta.md', basename: 'Project - Beta' },
      ] as ConstructorParameters<typeof ProjectSettingsModal>[1]['projectFiles'],
      onSubmit: async (projectPath) => {
        saved.push(projectPath)
      },
    })

    const select = modal.contentEl.querySelector('select') as HTMLSelectElement
    // The configured title prefix is stripped from what the user reads.
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'No project',
      'Alpha',
      'Beta',
    ])

    select.value = 'Projects/Project - Beta.md'
    select.dispatchEvent(new Event('change'))

    const buttons = modal.contentEl.querySelectorAll('.modal-button-container button')
    const save = Array.from(buttons).find((button) => button.textContent === 'Save')
    save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()

    expect(saved).toEqual(['Projects/Project - Beta.md'])
  })

  test('labels the blank entry as a removal once a project is assigned', () => {
    const modal = openModal({
      projectFiles: [
        { path: 'Projects/Project - Alpha.md', basename: 'Project - Alpha' },
      ] as ConstructorParameters<typeof ProjectSettingsModal>[1]['projectFiles'],
      currentProjectPath: 'Projects/Project - Alpha.md',
    })

    const select = modal.contentEl.querySelector('select') as HTMLSelectElement
    expect(select.options[0].textContent).toContain('Remove project')
    expect(select.value).toBe('Projects/Project - Alpha.md')

    modal.close()
  })
})
