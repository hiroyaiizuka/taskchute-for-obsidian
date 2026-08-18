module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.[tj]s?(x)'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/__mocks__/obsidian.js',
    // esbuild loads .css imports as text (see esbuild.config.mjs); mirror
    // that contract with a string-exporting stub.
    '\\.css$': '<rootDir>/tests/setup/css-text-stub.js',
    // Real xterm probes canvas APIs jsdom lacks, and tests always mock the
    // TerminalViewAdapter anyway (never instantiate real xterm in jsdom).
    '^@xterm/xterm$': '<rootDir>/tests/setup/xterm-stub.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  setupFilesAfterEnv: [
    '<rootDir>/tests/setup/obsidian-dom-globals.ts',
    '<rootDir>/tests/setup/console-silence.ts',
  ],
};
