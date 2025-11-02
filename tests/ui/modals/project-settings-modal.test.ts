import { mockApp } from 'obsidian'
import ProjectSettingsModal from '../../../src/ui/modals/ProjectSettingsModal'
import type { TaskChutePluginLike } from '../../../src/types'

describe('ProjectSettingsModal empty state', () => {
  test('shows empty-state message without mentioning #project tag', () => {
    const app = mockApp
    const plugin = {
      settings: {
        projectTitlePrefix: 'Project - ',
      },
    } as unknown as TaskChutePluginLike

    const modal = new ProjectSettingsModal(app as never, {
      app: app as never,
      plugin,
      tv: (_key, fallback) => fallback,
      displayTitle: 'Sample',
      projectFiles: [],
      currentProjectPath: undefined,
      onSubmit: async () => {},
    })

    ;(modal as unknown as { renderFooter(parent: HTMLElement): HTMLElement }).renderFooter = (parent) => {
      const footer = parent.createEl('div') as HTMLElement
      const cancel = footer.createEl('button', { cls: 'form-button cancel' }) as HTMLElement & {
        addEventListener?: jest.Mock
      }
      const submit = footer.createEl('button', { cls: 'form-button create' }) as HTMLElement
      Object.defineProperty(footer, 'querySelector', {
        value: (selector: string) => {
          if (selector === '.form-button.cancel') return cancel
          if (selector === '.form-button.create') return submit
          return null
        },
      })
      return footer
    }

    modal.onOpen()

    const body = (modal.contentEl.children || []).find(
      (child) => (child as HTMLElement).className?.includes('project-settings-body'),
    ) as (HTMLElement & { children: HTMLElement[] }) | undefined
    expect(body).toBeDefined()

    const texts = (body?.children || []).map((child) => child.textContent || '')
    expect(texts.join(' ')).toContain('No project files found')
    expect(texts.join(' ')).not.toContain('#project')
  })
})
