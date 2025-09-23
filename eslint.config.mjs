import { fileURLToPath } from "node:url";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

const sharedGlobals = {
  console: "readonly",
  window: "readonly",
  document: "readonly",
  localStorage: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  Option: "readonly",
  confirm: "readonly",
};

const jestGlobals = {
  afterAll: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  jest: "readonly",
  test: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      ".obsidian/**",
      ".husky/**",
      "my-docs/**",
      "tmp/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx,js}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir,
      },
      globals: sharedGlobals,
    },
  },
  {
    files: ["tests/**/*.{ts,tsx,js,jsx}", "**/*.test.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir,
      },
      globals: { ...sharedGlobals, ...jestGlobals },
    },
  },
  {
    files: ["src/**/*.{ts,tsx,js}", "tests/**/*.{ts,tsx,js,jsx}", "**/*.test.{ts,tsx,js,jsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-alert": "warn",
      "no-restricted-globals": "warn",
      "obsidianmd/no-static-styles-assignment": "warn",
      "obsidianmd/prefer-file-manager-trash-file": "warn",
    },
  },
];
