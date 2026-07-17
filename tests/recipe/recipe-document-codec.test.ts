import {
  RecipeDocumentCodec,
  RecipeDocumentCorruptError,
  RecipeDocumentInputError,
  RecipeMigrationNeedsReviewError,
} from '../../src/features/recipe/services/RecipeDocumentCodec'

const codec = new RecipeDocumentCodec()

describe('RecipeDocumentCodec', () => {
  test('writes and reads all Recipe v2 contract sections', () => {
    const markdown = codec.write(undefined, {
      title: '記事を公開する',
      goal: '公開URLを確認できること',
      steps: [{ id: 'step-proofread', text: '原稿を校正する' }],
      qualityChecks: [{ id: 'quality-links', text: 'リンク切れがない' }],
      constraints: ['個人情報を含めない'],
    })

    expect(markdown).toContain('taskchute_recipe_version: 2')
    expect(markdown).toContain('<!-- taskchute-recipe:quality-checklist:start -->')
    expect(codec.parse(markdown)).toMatchObject({
      schemaVersion: 2,
      title: '記事を公開する',
      goal: '公開URLを確認できること',
      steps: [{ id: 'step-proofread', text: '原稿を校正する' }],
      qualityChecks: [{ id: 'quality-links', text: 'リンク切れがない' }],
      constraints: [{ text: '個人情報を含めない' }],
    })
  })

  test('updates only managed frontmatter and marker sections', () => {
    const original = codec.write(undefined, {
      title: '旧タイトル',
      goal: '旧ゴール',
      steps: [{ id: 'step-a', text: '旧手順' }],
      qualityChecks: [],
      constraints: [],
    })
      .replace(
        'taskchute_recipe: true',
        'aliases:\n  - preserved\ncustom:\n  title: nested title must stay\ntaskchute_recipe: true',
      )
      .replace(
        '<!-- taskchute-recipe:checklist:end -->',
        '<!-- taskchute-recipe:checklist:end -->\n\n手入力した説明は残る',
      )

    const updated = codec.write(original, {
      title: '新タイトル',
      goal: '新ゴール',
      steps: [{ id: 'step-a', text: '新しい手順' }],
      qualityChecks: [{ id: 'quality-a', text: '品質確認' }],
      constraints: ['削除しない'],
    })

    expect(updated).toContain('aliases:\n  - preserved')
    expect(updated).toContain('custom:\n  title: nested title must stay')
    expect(updated).toContain('手入力した説明は残る')
    expect(updated).not.toContain('旧ゴール')
    expect(codec.parse(updated).qualityChecks).toEqual([{ id: 'quality-a', text: '品質確認' }])
  })

  test('preserves CRLF when updating a v2 document', () => {
    const original = codec.write(undefined, {
      title: 'CRLF',
      goal: 'A',
      steps: [{ id: 'step-a', text: 'A' }],
      qualityChecks: [],
      constraints: [],
    }).replace(/\n/gu, '\r\n')

    const updated = codec.write(original, {
      title: 'CRLF',
      goal: 'B\nC',
      steps: [{ id: 'step-a', text: 'B' }],
      qualityChecks: [],
      constraints: [],
    })

    expect(updated.replace(/\r\n/gu, '')).not.toContain('\n')
  })

  test('reads markerless files as Recipe v1 and safely migrates one checklist block', () => {
    const legacy = [
      '---',
      'title: Legacy',
      'aliases:',
      '  - preserved',
      '---',
      '',
      '前置きも保持する',
      '- [ ] 手順A',
      '- [x] 手順B',
      '',
      '後書きも保持する',
      '',
    ].join('\n')
    const parsed = codec.parse(legacy)

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.steps).toHaveLength(2)

    const migrated = codec.write(legacy, {
      title: 'Legacy',
      goal: '完了していること',
      steps: parsed.steps,
      qualityChecks: [],
      constraints: [],
    })

    expect(migrated).toContain('aliases:\n  - preserved')
    expect(migrated).toContain('前置きも保持する')
    expect(migrated).toContain('後書きも保持する')
    expect(migrated).toContain(`<!-- taskchute-step-id: ${parsed.steps[0].id} -->`)
    expect(codec.parse(migrated).schemaVersion).toBe(2)
  })

  test('refuses an ambiguous legacy migration', () => {
    const legacy = '- [ ] 手順A\n\n説明\n\n- [ ] 手順B\n'
    const parsed = codec.parse(legacy)

    try {
      codec.write(legacy, {
        title: 'Legacy',
        goal: '',
        steps: parsed.steps,
        qualityChecks: [],
        constraints: [],
      })
      throw new Error('Expected migration to require review')
    } catch (error) {
      expect(error).toBeInstanceOf(RecipeMigrationNeedsReviewError)
      expect((error as RecipeMigrationNeedsReviewError).preview).toContain('手順A')
    }
  })

  test('rejects incomplete markers and duplicate stable IDs', () => {
    const valid = codec.write(undefined, {
      title: 'Broken',
      goal: '',
      steps: [{ id: 'step-a', text: 'A' }],
      qualityChecks: [],
      constraints: [],
    })
    const incomplete = valid.replace('<!-- taskchute-recipe:goal:end -->', '')
    const duplicate = valid.replace(
      '- [ ] A <!-- taskchute-step-id: step-a -->',
      '- [ ] A <!-- taskchute-step-id: step-a -->\n- [ ] B <!-- taskchute-step-id: step-a -->',
    )

    expect(() => codec.parse(incomplete)).toThrow(RecipeDocumentCorruptError)
    expect(() => codec.parse(duplicate)).toThrow(RecipeDocumentCorruptError)
  })

  test('rejects reserved markers and NUL in user input', () => {
    expect(() => codec.write(undefined, {
      title: 'Unsafe',
      goal: '<!-- taskchute-recipe:goal:end -->',
      steps: [],
      qualityChecks: [],
      constraints: [],
    })).toThrow(RecipeDocumentInputError)

    expect(() => codec.write(undefined, {
      title: 'Unsafe',
      goal: 'bad\0value',
      steps: [],
      qualityChecks: [],
      constraints: [],
    })).toThrow(RecipeDocumentInputError)
  })

  test.each([
    ['procedure', { steps: [{ id: 'step-a', text: 'line 1\nline 2' }], qualityChecks: [], constraints: [] }],
    ['quality', { steps: [], qualityChecks: [{ id: 'quality-a', text: 'line 1\rline 2' }], constraints: [] }],
    ['constraint', { steps: [], qualityChecks: [], constraints: ['line 1\r\nline 2'] }],
  ])('rejects CR/LF injection in %s list items', (_label, fields) => {
    expect(() => codec.write(undefined, {
      title: 'Unsafe',
      goal: 'Multiline\ngoals remain supported',
      ...fields,
    })).toThrow(RecipeDocumentInputError)
  })

  test('rejects unknown schema versions instead of treating them as v1', () => {
    const unknown = [
      '---',
      'taskchute_recipe: true',
      'taskchute_recipe_version: 3',
      'title: Unknown',
      '---',
      '',
      '- [ ] Legacy-looking item',
      '',
    ].join('\n')

    expect(() => codec.parse(unknown)).toThrow(RecipeDocumentCorruptError)
    expect(() => codec.write(unknown, {
      title: 'Unknown',
      goal: '',
      steps: [],
      qualityChecks: [],
      constraints: ['Do not migrate silently'],
    })).toThrow(RecipeDocumentCorruptError)

    const emptyVersion = unknown.replace('taskchute_recipe_version: 3', 'taskchute_recipe_version:')
    expect(() => codec.parse(emptyVersion)).toThrow(RecipeDocumentCorruptError)
  })

  test('only treats markers after frontmatter as managed Recipe markers', () => {
    const legacy = [
      '---',
      'title: Marker metadata',
      'custom: "<!-- taskchute-recipe:goal:start -->"',
      '---',
      '',
      '- [ ] Legacy step',
      '',
    ].join('\n')

    expect(codec.parse(legacy)).toMatchObject({
      schemaVersion: 1,
      steps: [{ text: 'Legacy step' }],
    })
  })

  test('requires review rather than orphaning YAML block scalar continuation lines', () => {
    const legacy = [
      '---',
      'title: |',
      '  Multiline title',
      '  must stay attached',
      'custom: preserved',
      '---',
      '',
      '- [ ] Legacy step',
      '',
    ].join('\n')

    expect(() => codec.write(legacy, {
      title: 'Replacement',
      goal: '',
      steps: [{ id: 'step-a', text: 'Legacy step' }],
      qualityChecks: [],
      constraints: [],
    })).toThrow(RecipeMigrationNeedsReviewError)
  })

  test.each([
    ['checklist', '- [ ] A <!-- taskchute-step-id: step-a -->', 'plain text is not a step'],
    ['quality-checklist', '- [ ] A <!-- taskchute-quality-check-id: quality-a -->', 'plain text is not a quality check'],
    ['constraints', '- A', 'plain text is not a constraint'],
  ])('rejects unmanaged lines inside the v2 %s section', (section, validLine, invalidLine) => {
    const valid = codec.write(undefined, {
      title: 'Strict sections',
      goal: '',
      steps: [{ id: 'step-a', text: 'A' }],
      qualityChecks: [{ id: 'quality-a', text: 'A' }],
      constraints: ['A'],
    })
    const corrupted = valid.replace(validLine, `${validLine}\n${invalidLine}`)

    expect(corrupted).toContain(`taskchute-recipe:${section}:start`)
    expect(() => codec.parse(corrupted)).toThrow(RecipeDocumentCorruptError)
  })
})
