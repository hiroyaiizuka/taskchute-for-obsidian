import type { WorkspaceLeaf } from 'obsidian'
import { showLeaf } from '@/utils/showLeaf'

const leaf = {} as WorkspaceLeaf

describe('showLeaf', () => {
  test('brings the leaf forward, then makes it the current leaf', async () => {
    const calls: string[] = []
    const workspace = {
      revealLeaf: jest.fn(async () => {
        calls.push('reveal')
      }),
      setActiveLeaf: jest.fn(() => {
        calls.push('activate')
      }),
    }

    await showLeaf(workspace, leaf)

    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf)
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true })
    // revealLeaf may first load a deferred view; activate only after it.
    expect(calls).toEqual(['reveal', 'activate'])
  })

  test('passes focus: false through', async () => {
    const workspace = { revealLeaf: jest.fn(async () => undefined), setActiveLeaf: jest.fn() }
    await showLeaf(workspace, leaf, { focus: false })
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: false })
  })

  test('still makes the leaf current where revealLeaf is missing', async () => {
    const workspace = { setActiveLeaf: jest.fn() }
    await showLeaf(workspace, leaf)
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true })
  })
})
