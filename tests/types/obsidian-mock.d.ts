/**
 * Extra exports provided by the jest manual mock (`__mocks__/obsidian.js`).
 * They do not exist in the real `obsidian` module, so they are declared here
 * for tests only.
 */
import 'obsidian'

declare module 'obsidian' {
  export const mockApp: App & {
    workspace: App['workspace'] & {
      openLinkText: jest.Mock
      getLeavesOfType: jest.Mock<unknown[], [string]>
      onLayoutReady: jest.Mock<void, [() => void]>
    }
  }

  export const mockLeaf: {
    containerEl: { children: HTMLElement[] }
  }
}
