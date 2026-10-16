module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.[tj]s?(x)'],
  moduleNameMapper: {
    // Mirrors the `paths` map in tsconfig.test.json. Both have to be kept in
    // step: tsc resolves the aliases for typecheck, Jest for the run.
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1',
    '^obsidian$': '<rootDir>/__mocks__/obsidian.js',
    // Real xterm probes canvas APIs jsdom lacks, and tests always mock the
    // TerminalViewAdapter anyway (never instantiate real xterm in jsdom).
    '^@xterm/xterm$': '<rootDir>/tests/setup/xterm-stub.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  setupFilesAfterEnv: [
    '<rootDir>/tests/setup/web-platform-globals.ts',
    '<rootDir>/tests/setup/obsidian-dom-globals.ts',
    '<rootDir>/tests/setup/console-silence.ts',
  ],
};
