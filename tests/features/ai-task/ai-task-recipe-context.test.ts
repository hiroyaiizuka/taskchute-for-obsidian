import { TFile } from 'obsidian'
import {
  AiTaskManager,
  type AiTaskManagerDeps,
} from '../../../src/features/ai-task/services/AiTaskManager'
import type {
  AiDispatcher,
  AiRunCallbacks,
  AiRunRequest,
} from '../../../src/features/ai-task/services/dispatchers/Dispatcher'
import type { RecipeContextSnapshot } from '../../../src/features/recipe/services/RecipeDelegationContextBuilder'
import {
  AI_RUN_MAX_LAUNCH_SIZE,
  AiRunLaunchTooLargeError,
} from '../../../src/features/ai-task/services/AiRunLaunchSizeGuard'

class CapturingDispatcher implements AiDispatcher {
  readonly requests: AiRunRequest[] = []
  readonly callbacks: AiRunCallbacks[] = []

  start(request: AiRunRequest, callbacks: AiRunCallbacks) {
    this.requests.push(request)
    this.callbacks.push(callbacks)
    return {
      pid: 123,
      stop: jest.fn(),
      forceKill: jest.fn(),
    }
  }
}

function taskFile(): TFile {
  const file = new TFile()
  file.path = 'TaskChute/Task/AI Publish.md'
  file.basename = 'AI Publish'
  file.extension = 'md'
  return file
}

const snapshot: RecipeContextSnapshot = {
  recipePath: 'TaskChute/Recipes/Publish.md',
  recipeVersion: 2,
  recipeContentHash: '0123456789abcdef',
  payload: {
    schemaVersion: 2,
    title: 'Publish',
    goal: 'A public URL exists',
    procedureChecklist: [{ id: 'step-1', text: 'Publish' }],
    qualityChecklist: [{ id: 'quality-1', text: 'Open the URL' }],
    constraints: ['Do not expose secrets'],
  },
}

describe('AiTaskManager Recipe v2 integration', () => {
  test('injects one snapshot into the initial request, records audit metadata, and never repeats it on follow-up', async () => {
    const dispatcher = new CapturingDispatcher()
    const deps: AiTaskManagerDeps = {
      app: {
        vault: {
          cachedRead: async () => '# AI Publish\n',
          adapter: { getBasePath: () => '/vault' },
        },
        metadataCache: {
          getFileCache: () => ({
            frontmatter: {
              ai_task: true,
              recipe: '[[TaskChute/Recipes/Publish]]',
            },
          }),
        },
      },
      dispatchers: { claude: dispatcher, codex: dispatcher },
      binaryLocator: { resolve: async () => '/bin/claude' },
      logWriter: {
        writeRunLog: async () => 'log.md',
        upsertRunLog: async () => 'log.md',
        pruneOldLogs: async () => undefined,
      },
      recipeContextProvider: {
        getSnapshot: async () => snapshot,
      },
    }
    const manager = new AiTaskManager(deps)

    const prepared = await manager.prepareRun(taskFile(), { mode: 'headless' })
    expect(dispatcher.requests).toHaveLength(0)
    const record = await manager.startPreparedRun(prepared)

    expect(record).toMatchObject({
      recipePath: snapshot.recipePath,
      recipeVersion: snapshot.recipeVersion,
      recipeContentHash: snapshot.recipeContentHash,
    })
    expect(dispatcher.requests[0].prompt).toContain(
      '# TaskChute execution contract',
    )
    expect(
      dispatcher.requests[0].prompt.match(/# TaskChute execution contract/gu),
    ).toHaveLength(1)

    dispatcher.callbacks[0].onEvent({
      kind: 'init',
      sessionId: 'session-1',
    })
    dispatcher.callbacks[0].onExit({
      status: 'succeeded',
      exitCode: 0,
      signal: null,
    })
    await manager.followUp(record.id, 'One more thing')

    expect(dispatcher.requests[1].prompt).toBe('One more thing')
    expect(dispatcher.requests[1].prompt).not.toContain(
      '# TaskChute execution contract',
    )
    expect(record.recipeContentHash).toBe(snapshot.recipeContentHash)
  })

  test('rejects an oversized composed recipe prompt during preflight before dispatch', async () => {
    const dispatcher = new CapturingDispatcher()
    const oversizedSnapshot: RecipeContextSnapshot = {
      ...snapshot,
      payload: {
        ...snapshot.payload,
        goal: 'x'.repeat(AI_RUN_MAX_LAUNCH_SIZE),
      },
    }
    const deps: AiTaskManagerDeps = {
      app: {
        vault: {
          cachedRead: async () => '# AI Publish\n',
          adapter: { getBasePath: () => '/vault' },
        },
        metadataCache: {
          getFileCache: () => ({
            frontmatter: {
              ai_task: true,
              recipe: '[[TaskChute/Recipes/Publish]]',
            },
          }),
        },
      },
      dispatchers: { claude: dispatcher, codex: dispatcher },
      binaryLocator: { resolve: async () => '/bin/claude' },
      logWriter: {
        writeRunLog: async () => 'log.md',
        pruneOldLogs: async () => undefined,
      },
      recipeContextProvider: {
        getSnapshot: async () => oversizedSnapshot,
      },
    }
    const manager = new AiTaskManager(deps)

    await expect(
      manager.prepareRun(taskFile(), { mode: 'headless' }),
    ).rejects.toBeInstanceOf(AiRunLaunchTooLargeError)
    expect(dispatcher.requests).toHaveLength(0)
    expect(manager.getRuns()).toHaveLength(0)
  })
})
