import { projectChoices } from '@/ui/project/projectChoices'

const projects = [
  { path: 'Projects/Project - 引っ越し.md', name: '引っ越し' },
  { path: 'Projects/Project - ブログ記事.md', name: 'ブログ記事' },
  { path: 'Projects/Project - Blog redesign.md', name: 'Blog redesign' },
]

const summary = (choices: ReturnType<typeof projectChoices>) =>
  choices.map((choice) =>
    choice.kind === 'project' ? `${choice.name}${choice.current ? ' ✓' : ''}` : choice.kind === 'create' ? `+${choice.title}` : '-',
  )

describe('projectChoices', () => {
  test('with nothing typed: every project, and removal first when one is linked', () => {
    expect(summary(projectChoices('', projects, null))).toEqual(['引っ越し', 'ブログ記事', 'Blog redesign'])
    expect(summary(projectChoices('  ', projects, 'Projects/Project - ブログ記事.md'))).toEqual([
      '-',
      '引っ越し',
      'ブログ記事 ✓',
      'Blog redesign',
    ])
  })

  test('a new name: the closest match stays first (Enter picks it), creating comes right after', () => {
    expect(summary(projectChoices('ブロ', projects, null))).toEqual(['ブログ記事', '+ブロ'])
    expect(summary(projectChoices('blog', projects, null))).toEqual(['Blog redesign', '+blog'])
  })

  test('a name nothing matches: creating is the only choice', () => {
    expect(summary(projectChoices(' 新企画 ', projects, null))).toEqual(['+新企画'])
    expect(summary(projectChoices('新企画', [], null))).toEqual(['+新企画'])
  })

  test('an existing name (any case) is not offered for creation again', () => {
    expect(summary(projectChoices('blog REDESIGN', projects, null))).toEqual(['Blog redesign'])
  })

  test('no projects and nothing typed: nothing to show (the empty state explains)', () => {
    expect(projectChoices('', [], null)).toEqual([])
  })
})
