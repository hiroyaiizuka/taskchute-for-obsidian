module.exports = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.global.js", "<rootDir>/jest.setup.js", "<rootDir>/jest.setup.fix.js"],
  testMatch: ["<rootDir>/__tests__/**/*.test.js"],
  collectCoverageFrom: ["main.js", "!**/node_modules/**", "!**/__tests__/**"],
  coverageReporters: ["text", "lcov", "html"],
  moduleNameMapper: {
    "^obsidian$": "<rootDir>/__mocks__/obsidian.js",
  },
  testTimeout: 10000,
  verbose: true
}
