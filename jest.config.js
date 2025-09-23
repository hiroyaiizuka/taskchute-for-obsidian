module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.[tj]s?(x)'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  verbose: true,
};
