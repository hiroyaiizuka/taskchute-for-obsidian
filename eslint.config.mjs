import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

const require = createRequire(import.meta.url);

if (typeof globalThis.structuredClone !== "function") {
  let candidate;
  try {
    ({ structuredClone: candidate } = require("node:util"));
  } catch (error) {
    candidate = undefined;
  }

  if (typeof candidate !== "function") {
    candidate = (value) => JSON.parse(JSON.stringify(value));
  }

  globalThis.structuredClone = candidate;
}

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

// Filter recommendedTypeChecked to only apply to TS files
const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map(config => {
  if (config.rules) {
    return {
      ...config,
      files: ["**/*.ts", "**/*.tsx"],
    };
  }
  return config;
});

export default [
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      ".obsidian/**",
      ".husky/**",
      "taskchute-docs/**",
      "tmp/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  // Add type-checked rules from typescript-eslint (matches Obsidian review system)
  ...typeCheckedConfigs,
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
    rules: {
      // Relax some rules for test files - tests often need flexible mocking
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx,js}"],
    rules: {
      // Minimal overrides
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      // Ensure type-aware rules are strict (matches Obsidian review)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/unbound-method": "error",
    },
  },
];
