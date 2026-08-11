import type { App } from 'obsidian'
import type { PathManagerLike } from '../../src/types'
import { ProjectNoteSyncService } from '../../src/features/project/services/ProjectNoteSyncService'

describe('ProjectNoteSyncService', () => {
  const createService = () => new ProjectNoteSyncService(
    {} as unknown as App,
    {} as unknown as PathManagerLike,
  )

  it('appends new comment lines for the same task on the same date', () => {
    const service = createService() as unknown as {
      upsertLogEntry: (
        logBody: string,
        dateString: string,
        taskTitle: string,
        commentLines: string[],
      ) => string
    }

    const initialLogBody = [
      '- [[2025-05-02]]',
      '    - Project Task',
      '        - First comment',
    ].join('\n')

    const nextCommentLines = ['        - Second comment']

    const updated = service.upsertLogEntry(
      initialLogBody,
      '2025-05-02',
      'Project Task',
      nextCommentLines,
    )

    expect(updated.trim()).toBe(
      [
        '- [[2025-05-02]]',
        '    - Project Task',
        '        - First comment',
        '        - Second comment',
      ].join('\n'),
    )
  })
})
