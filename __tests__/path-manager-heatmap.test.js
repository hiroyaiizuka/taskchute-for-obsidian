const { TaskChutePlugin } = require('../main')
const { TFolder } = require('obsidian')

describe('PathManager - Heatmap features', () => {
  let plugin
  let pathManager
  let mockApp
  let mockVault

  beforeEach(() => {
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      createFolder: jest.fn().mockResolvedValue()
    }

    mockApp = {
      vault: mockVault
    }

    plugin = new TaskChutePlugin()
    plugin.app = mockApp
    plugin.settings = {
      logDataPath: 'TaskChute/Log'
    }

    // Initialize pathManager manually since it's not initialized in constructor
    const PathManager = require('../main').PathManager
    plugin.pathManager = new PathManager(plugin)
    pathManager = plugin.pathManager
  })

  describe('getLogYearPath', () => {
    test('should return correct year path', () => {
      const result = pathManager.getLogYearPath(2025)
      expect(result).toBe('TaskChute/Log/2025')
    })

    test('should use custom log path if configured', () => {
      plugin.settings.logDataPath = 'Custom/LogPath'
      const result = pathManager.getLogYearPath(2024)
      expect(result).toBe('Custom/LogPath/2024')
    })

    test('should handle year as string', () => {
      const result = pathManager.getLogYearPath('2023')
      expect(result).toBe('TaskChute/Log/2023')
    })
  })

  describe('ensureYearFolder', () => {
    test('should create year folder if it does not exist', async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null)
      
      const result = await pathManager.ensureYearFolder(2025)
      
      expect(result).toBe('TaskChute/Log/2025')
      expect(mockVault.createFolder).toHaveBeenCalledWith('TaskChute/Log/2025')
    })

    test('should not create folder if it already exists', async () => {
      const mockFolder = { path: 'TaskChute/Log/2025' } // Mock TFolder object
      mockVault.getAbstractFileByPath.mockReturnValue(mockFolder)
      
      const result = await pathManager.ensureYearFolder(2025)
      
      expect(result).toBe('TaskChute/Log/2025')
      expect(mockVault.createFolder).not.toHaveBeenCalled()
    })

    test('should handle folder creation errors', async () => {
      mockVault.getAbstractFileByPath.mockReturnValue(null)
      mockVault.createFolder.mockRejectedValue(new Error('Permission denied'))
      
      await expect(pathManager.ensureYearFolder(2025)).rejects.toThrow('Permission denied')
    })
  })
})