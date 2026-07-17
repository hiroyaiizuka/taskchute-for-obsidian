import { TFile } from 'obsidian'
import { RecipeService, createRecipeProgressKey, createRecipeProgressKeyForInstance, createRecipeStepId, normalizeRecipeReference } from '../../src/features/recipe/services/RecipeService'

function createFile(path: string): TFile {
  const file = new TFile()
  file.path = path
  file.basename = path.split('/').pop()?.replace(/\.md$/u, '') ?? path
  file.extension = 'md'
  return file
}

function createPlugin(files: Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>) {
  return {
    app: {
      vault: {
        getMarkdownFiles: jest.fn(() => Array.from(files.values()).map((entry) => entry.file)),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'TaskChute/Recipes' || path === 'TaskChute/Task') {
            return {
              path,
              children: Array.from(files.values())
                .map((entry) => entry.file)
                .filter((file) => file.path.startsWith(`${path}/`)),
            }
          }
          return files.get(path)?.file ?? null
        }),
        read: jest.fn(async (file: TFile) => files.get(file.path)?.content ?? ''),
        modify: jest.fn(async (file: TFile, content: string) => {
          const entry = files.get(file.path)
          if (entry) {
            entry.content = content
          }
        }),
        create: jest.fn(async (path: string, content: string) => {
          const file = createFile(path)
          files.set(path, { file, content, frontmatter: { taskchute_recipe: true, title: file.basename } })
          return file
        }),
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => {
          const frontmatter = files.get(file.path)?.frontmatter
          return frontmatter ? { frontmatter } : undefined
        }),
      },
      fileManager: {
        trashFile: jest.fn(async (file: TFile) => {
          files.delete(file.path)
        }),
        processFrontMatter: jest.fn(async (file: TFile, updater: (frontmatter: Record<string, unknown>) => void) => {
          const entry = files.get(file.path)
          if (!entry) return
          const frontmatter = entry.frontmatter ?? {}
          updater(frontmatter)
          entry.frontmatter = frontmatter
        }),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
    },
    pathManager: {
      getRecipeFolderPath: () => 'TaskChute/Recipes',
      getTaskFolderPath: () => 'TaskChute/Task',
      ensureFolderExists: jest.fn(),
    },
  }
}

describe('RecipeService', () => {
  test('normalizes markdown and wikilink recipe references', () => {
    expect(normalizeRecipeReference('TaskChute/Recipes/Gym')).toBe('TaskChute/Recipes/Gym.md')
    expect(normalizeRecipeReference('[[TaskChute/Recipes/Gym|ジム]]')).toBe('TaskChute/Recipes/Gym.md')
    expect(normalizeRecipeReference('')).toBeUndefined()
  })

  test('loads recipes from markdown checklist steps', async () => {
    const file = createFile('TaskChute/Recipes/Gym.md')
    const files = new Map([
      [file.path, {
        file,
        frontmatter: { taskchute_recipe: true, title: 'ジム基本' },
        content: '---\ntitle: ジム基本\n---\n\n- [ ] 筋トレをする\n- [x] 散歩する\nplain text',
      }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    const recipe = await service.loadRecipe(file.path)

    expect(recipe.title).toBe('ジム基本')
    expect(recipe.steps).toEqual([
      { id: createRecipeStepId(0, '筋トレをする'), text: '筋トレをする' },
      { id: createRecipeStepId(1, '散歩する'), text: '散歩する' },
    ])
  })

  test('keeps recipe step ids stable when steps are reordered or inserted before them', () => {
    const service = new RecipeService(createPlugin(new Map()) as never)

    const original = service.parseSteps('- [ ] 筋トレをする\n- [ ] 散歩する\n')
    const reordered = service.parseSteps('- [ ] 水を飲む\n- [ ] 散歩する\n- [ ] 筋トレをする\n')

    expect(reordered.find((step) => step.text === '筋トレをする')?.id).toBe(
      original.find((step) => step.text === '筋トレをする')?.id,
    )
    expect(reordered.find((step) => step.text === '散歩する')?.id).toBe(
      original.find((step) => step.text === '散歩する')?.id,
    )
  })

  test('assigns unique step ids to duplicate recipe step text', () => {
    const service = new RecipeService(createPlugin(new Map()) as never)

    const steps = service.parseSteps('- [ ] 水を飲む\n- [ ] 水を飲む\n')

    expect(steps).toHaveLength(2)
    expect(steps[0].text).toBe('水を飲む')
    expect(steps[1].text).toBe('水を飲む')
    expect(steps[0].id).not.toBe(steps[1].id)
  })

  test('saves new recipe as markdown with taskchute_recipe frontmatter', async () => {
    const files = new Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>()
    const plugin = createPlugin(files)
    const service = new RecipeService(plugin as never)

    await service.saveRecipe({ title: 'ジム基本', steps: ['筋トレをする', '散歩する'] })

    expect(plugin.pathManager.ensureFolderExists).toHaveBeenCalledWith('TaskChute/Recipes')
    expect(plugin.app.vault.create).toHaveBeenCalledWith(
      'TaskChute/Recipes/ジム基本.md',
      expect.stringContaining('taskchute_recipe: true'),
    )
    expect(files.get('TaskChute/Recipes/ジム基本.md')?.content).toContain('- [ ] 筋トレをする')
  })

  test('saves goal, quality checks and constraints without procedure steps', async () => {
    const files = new Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>()
    const service = new RecipeService(createPlugin(files) as never)

    const recipe = await service.saveRecipe({
      title: '公開品質',
      goal: '公開URLを確認できること',
      steps: [],
      qualityChecks: ['リンク切れがない'],
      constraints: ['個人情報を含めない'],
    })

    expect(recipe.schemaVersion).toBe(2)
    expect(recipe.goal).toBe('公開URLを確認できること')
    expect(recipe.qualityChecks[0]).toMatchObject({ text: 'リンク切れがない' })
    expect(recipe.qualityChecks[0].id).toMatch(/^quality-/u)
    expect(recipe.constraints[0]).toMatchObject({ text: '個人情報を含めない' })
  })

  test('only preserves IDs through explicit IDs or exact text matches', async () => {
    const files = new Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>()
    const service = new RecipeService(createPlugin(files) as never)
    const created = await service.saveRecipe({
      title: '安定ID',
      steps: ['旧手順'],
      qualityChecks: ['旧品質'],
    })

    const updated = await service.saveRecipe({
      path: created.path,
      title: '安定ID',
      steps: [
        { id: created.steps[0].id, text: '編集済み手順' },
        '新しい手順',
      ],
      qualityChecks: [
        { id: created.qualityChecks[0].id, text: '編集済み品質' },
        '新しい品質',
      ],
    })

    expect(updated.steps[0].id).toBe(created.steps[0].id)
    expect(updated.qualityChecks[0].id).toBe(created.qualityChecks[0].id)
    expect(updated.steps[1].id).not.toBe(created.steps[0].id)
    expect(updated.qualityChecks[1].id).not.toBe(created.qualityChecks[0].id)
  })

  test('does not reuse a deleted row ID for a new row after deletion and reorder', async () => {
    const files = new Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>()
    const service = new RecipeService(createPlugin(files) as never)
    const created = await service.saveRecipe({
      title: '削除と並替',
      steps: ['A', 'B'],
    })
    const idA = created.steps.find((step) => step.text === 'A')?.id
    const idB = created.steps.find((step) => step.text === 'B')?.id

    const updated = await service.saveRecipe({
      path: created.path,
      title: '削除と並替',
      steps: ['B', 'C'],
    })

    expect(updated.steps.find((step) => step.text === 'B')?.id).toBe(idB)
    expect(updated.steps.find((step) => step.text === 'C')?.id).not.toBe(idA)
    expect(updated.steps.find((step) => step.text === 'C')?.id).not.toBe(idB)
  })

  test('returns saved title from raw frontmatter without waiting for metadata cache refresh', async () => {
    const file = createFile('TaskChute/Recipes/Gym.md')
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "古いタイトル"\n---\n\n- [ ] A\n',
        frontmatter: { taskchute_recipe: true, title: '古いタイトル' },
      }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    const recipe = await service.saveRecipe({
      path: file.path,
      title: '新しいタイトル',
      steps: ['A'],
    })

    expect(recipe.title).toBe('新しいタイトル')
    expect(files.get(file.path)?.frontmatter?.title).toBe('古いタイトル')
  })

  test('rejects saving a new recipe without any contract content', async () => {
    const files = new Map<string, { file: TFile; content: string; frontmatter?: Record<string, unknown> }>()
    const plugin = createPlugin(files)
    const service = new RecipeService(plugin as never)

    await expect(service.saveRecipe({ title: 'ジム基本', steps: [] })).rejects.toThrow(
      'Recipe requires at least one content field',
    )

    expect(plugin.app.vault.create).not.toHaveBeenCalled()
    expect(files.has('TaskChute/Recipes/ジム基本.md')).toBe(false)
  })

  test('assigns recipe as an Obsidian link so renames can update it', async () => {
    const task = createFile('TaskChute/Task/Gym.md')
    const recipe = createFile('TaskChute/Recipes/Gym.md')
    const files = new Map([
      [task.path, { file: task, content: '', frontmatter: { title: 'ジムに行く' } }],
      [recipe.path, { file: recipe, content: '- [ ] A', frontmatter: { title: 'Gym' } }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    await service.assignRecipeToTask(task.path, recipe.path)

    expect(files.get(task.path)?.frontmatter?.recipe).toBe('[[TaskChute/Recipes/Gym.md]]')
    expect(normalizeRecipeReference(files.get(task.path)?.frontmatter?.recipe)).toBe(recipe.path)
  })

  test('rejects folder-external and missing recipe references before task mutation', async () => {
    const task = createFile('TaskChute/Task/Gym.md')
    const externalRecipe = createFile('Other/Gym.md')
    const files = new Map([
      [task.path, { file: task, content: '', frontmatter: { title: 'ジムに行く' } }],
      [externalRecipe.path, { file: externalRecipe, content: '- [ ] A', frontmatter: { title: 'Gym' } }],
    ])
    const plugin = createPlugin(files)
    const service = new RecipeService(plugin as never)

    await expect(service.assignRecipeToTask(task.path, externalRecipe.path)).rejects.toThrow(
      'outside the configured recipe folder',
    )
    await expect(service.assignRecipeToTask(task.path, 'TaskChute/Recipes/Missing.md')).rejects.toThrow(
      'Recipe not found',
    )
    expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled()
  })

  test('rejects loading and saving through sibling-prefix recipe folders', async () => {
    const externalRecipe = createFile('TaskChute/Recipes-Archive/Gym.md')
    const files = new Map([
      [externalRecipe.path, { file: externalRecipe, content: '- [ ] A', frontmatter: { title: 'Gym' } }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    await expect(service.loadRecipe(externalRecipe.path)).rejects.toThrow(
      'outside the configured recipe folder',
    )
    await expect(service.saveRecipe({
      path: externalRecipe.path,
      title: 'Gym',
      steps: ['A'],
    })).rejects.toThrow('outside the configured recipe folder')
    await expect(service.saveRecipe({
      path: 'TaskChute/Recipes/Missing.md',
      title: 'Missing',
      steps: ['A'],
    })).rejects.toThrow('Recipe not found')
  })

  test('unassigns a recipe from a task without changing other frontmatter', async () => {
    const task = createFile('TaskChute/Task/Gym.md')
    const files = new Map([
      [task.path, {
        file: task,
        content: '',
        frontmatter: { title: 'ジムに行く', recipe: '[[TaskChute/Recipes/Gym.md]]', custom: true },
      }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    await service.unassignRecipeFromTask(task.path)

    expect(files.get(task.path)?.frontmatter).toEqual({ title: 'ジムに行く', custom: true })
  })

  test('deleting recipe unlinks tasks that reference it', async () => {
    const recipe = createFile('TaskChute/Recipes/Gym.md')
    const linkedTask = createFile('TaskChute/Task/Gym.md')
    const otherTask = createFile('TaskChute/Task/Other.md')
    const files = new Map([
      [recipe.path, { file: recipe, content: '- [ ] A', frontmatter: { title: 'Gym' } }],
      [linkedTask.path, {
        file: linkedTask,
        content: '',
        frontmatter: { title: 'ジムに行く', recipe: '[[TaskChute/Recipes/Gym.md]]' },
      }],
      [otherTask.path, {
        file: otherTask,
        content: '',
        frontmatter: { title: '別タスク', recipe: 'TaskChute/Recipes/Other.md' },
      }],
    ])
    const service = new RecipeService(createPlugin(files) as never)

    await service.deleteRecipe(recipe.path)

    expect(files.get(linkedTask.path)?.frontmatter?.recipe).toBeUndefined()
    expect(files.get(otherTask.path)?.frontmatter?.recipe).toBe('TaskChute/Recipes/Other.md')
    expect(files.has(recipe.path)).toBe(false)
  })

  test('keeps task recipe links when recipe trash fails', async () => {
    const recipe = createFile('TaskChute/Recipes/Gym.md')
    const linkedTask = createFile('TaskChute/Task/Gym.md')
    const files = new Map([
      [recipe.path, { file: recipe, content: '- [ ] A', frontmatter: { title: 'Gym' } }],
      [linkedTask.path, {
        file: linkedTask,
        content: '',
        frontmatter: { title: 'ジムに行く', recipe: '[[TaskChute/Recipes/Gym.md]]' },
      }],
    ])
    const plugin = createPlugin(files)
    plugin.app.fileManager.trashFile = jest.fn(async () => {
      throw new Error('trash failed')
    })
    const service = new RecipeService(plugin as never)

    await expect(service.deleteRecipe(recipe.path)).rejects.toThrow('trash failed')

    expect(files.get(linkedTask.path)?.frontmatter?.recipe).toBe('[[TaskChute/Recipes/Gym.md]]')
    expect(files.has(recipe.path)).toBe(true)
  })

  test('creates stable progress keys per instance and recipe path', () => {
    expect(createRecipeProgressKey('inst-1', 'TaskChute/Recipes/Gym.md')).toBe('inst-1::TaskChute/Recipes/Gym.md')
  })

  test('uses stable task identity for generated base instance ids so progress survives date navigation reloads', () => {
    const first = createRecipeProgressKeyForInstance({
      instanceId: 'TaskChute/Task/Gym.md_2026-05-04_111_aaa',
      task: {
        path: 'TaskChute/Task/Gym.md',
        taskId: 'task-gym',
      },
    } as never, 'TaskChute/Recipes/Gym.md')
    const second = createRecipeProgressKeyForInstance({
      instanceId: 'TaskChute/Task/Gym.md_2026-05-04_222_bbb',
      task: {
        path: 'TaskChute/Task/Gym.md',
        taskId: 'task-gym',
      },
    } as never, 'TaskChute/Recipes/Gym.md')

    expect(first).toBe(second)
    expect(first).toBe('task:task-gym::TaskChute/Recipes/Gym.md')
  })

  test('keeps generated duplicate instance ids separate for recipe progress', () => {
    const key = createRecipeProgressKeyForInstance({
      instanceId: 'TaskChute/Task/Gym.md_2026-05-04_111_aaa',
      isDuplicate: true,
      task: {
        path: 'TaskChute/Task/Gym.md',
        taskId: 'task-gym',
      },
    } as never, 'TaskChute/Recipes/Gym.md')

    expect(key).toBe('TaskChute/Task/Gym.md_2026-05-04_111_aaa::TaskChute/Recipes/Gym.md')
  })

  test('keeps explicit duplicate instance ids separate for recipe progress', () => {
    const key = createRecipeProgressKeyForInstance({
      instanceId: 'dup-1',
      task: {
        path: 'TaskChute/Task/Gym.md',
        taskId: 'task-gym',
      },
    } as never, 'TaskChute/Recipes/Gym.md')

    expect(key).toBe('dup-1::TaskChute/Recipes/Gym.md')
  })
})
