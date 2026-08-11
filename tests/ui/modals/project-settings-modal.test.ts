/**
 * @jest-environment jsdom
 */

import { createProjectSettingsModal } from '../../../src/ui/modals/ProjectSettingsModal'
import type { TaskChutePluginLike } from '../../../src/types'

// Mock iconUtils to avoid DOM append issues in test environment
jest.mock('../../../src/ui/components/iconUtils', () => ({
  attachCloseButtonIcon: jest.fn(),
  attachCalendarButtonIcon: jest.fn(),
}))

describe('ProjectSettingsModal empty state', () => {
  afterEach(() => {
    document.querySelectorAll('.task-modal-overlay').forEach((el) => el.remove())
  })

  test('shows empty-state message without mentioning #project tag', () => {
    const plugin = {
      settings: {
        projectTitlePrefix: 'Project - ',
      },
    } as unknown as TaskChutePluginLike

    const handle = createProjectSettingsModal({
      plugin,
      tv: (_key, fallback) => fallback,
      displayTitle: 'Sample',
      projectFiles: [],
      currentProjectPath: undefined,
      onSubmit: async () => {},
    })

    const body = handle.overlay.querySelector('.project-settings-body')
    expect(body).not.toBeNull()

    const text = body?.textContent || ''
    expect(text).toContain('No project files found')
    expect(text).not.toContain('#project')

    handle.close()
  })
})
