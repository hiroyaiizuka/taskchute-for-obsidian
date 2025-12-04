import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import sdl from "@microsoft/eslint-plugin-sdl";
// import json from "@eslint/json"; // Not used - manifest validation handled separately

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

// Obsidianmd plugin recommended rules (manually extracted to avoid 'extends' compatibility issue)
const obsidianmdRecommendedRules = {
  "obsidianmd/commands/no-command-in-command-id": "error",
  "obsidianmd/commands/no-command-in-command-name": "error",
  "obsidianmd/commands/no-default-hotkeys": "error",
  "obsidianmd/commands/no-plugin-id-in-command-id": "error",
  "obsidianmd/commands/no-plugin-name-in-command-name": "error",
  "obsidianmd/settings-tab/no-manual-html-headings": "error",
  "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
  "obsidianmd/vault/iterate": "error",
  "obsidianmd/detach-leaves": "error",
  "obsidianmd/hardcoded-config-path": "error",
  "obsidianmd/no-forbidden-elements": "error",
  "obsidianmd/no-plugin-as-component": "error",
  "obsidianmd/no-sample-code": "error",
  "obsidianmd/no-tfile-tfolder-cast": "error",
  "obsidianmd/no-view-references-in-plugin": "error",
  "obsidianmd/no-static-styles-assignment": "error",
  "obsidianmd/object-assign": "error",
  "obsidianmd/platform": "error",
  "obsidianmd/prefer-file-manager-trash-file": "warn",
  "obsidianmd/prefer-abstract-input-suggest": "error",
  "obsidianmd/regex-lookbehind": "error",
  "obsidianmd/sample-names": "error",
  "obsidianmd/validate-manifest": "error",
  "obsidianmd/validate-license": "error",
  "obsidianmd/ui/sentence-case": ["error", { enforceCamelCaseLower: true, brands: ["TaskChute"] }],
};

// General rules from obsidianmd recommended config
const obsidianmdGeneralRules = {
  "no-unused-vars": "off",
  "no-prototype-builtins": "off",
  "no-self-compare": "warn",
  "no-eval": "error",
  "no-implied-eval": "error",
  "prefer-const": "off",
  "no-implicit-globals": "error",
  "no-console": ["error", { allow: ["warn", "error", "debug"] }],
  "no-restricted-globals": [
    "error",
    {
      name: "app",
      message: "Avoid using the global app object. Instead use the reference provided by your plugin instance.",
    },
    "warn",
    {
      name: "fetch",
      message: "Use the built-in `requestUrl` function instead of `fetch` for network requests in Obsidian.",
    },
    {
      name: "localStorage",
      message: "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault."
    }
  ],
  "no-restricted-imports": [
    "error",
    {
      name: "axios",
      message: "Use the built-in `requestUrl` function instead of `axios`.",
    },
    {
      name: "superagent",
      message: "Use the built-in `requestUrl` function instead of `superagent`.",
    },
    {
      name: "got",
      message: "Use the built-in `requestUrl` function instead of `got`.",
    },
    {
      name: "ofetch",
      message: "Use the built-in `requestUrl` function instead of `ofetch`.",
    },
    {
      name: "ky",
      message: "Use the built-in `requestUrl` function instead of `ky`.",
    },
    {
      name: "node-fetch",
      message: "Use the built-in `requestUrl` function instead of `node-fetch`.",
    },
    {
      name: "moment",
      message: "The 'moment' package is bundled with Obsidian. Please import it from 'obsidian' instead.",
    },
  ],
  "no-alert": "error",
  "no-undef": "error",
  "@typescript-eslint/ban-ts-comment": "off",
  "@typescript-eslint/no-deprecated": "error",
  "@typescript-eslint/no-unused-vars": ["warn", { args: "none" }],
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/no-explicit-any": ["error", { fixToUnknown: true }],
  "@microsoft/sdl/no-document-write": "error",
  "@microsoft/sdl/no-inner-html": "error",
  "import/no-nodejs-modules": "error",
  "import/no-extraneous-dependencies": "error",
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
      "taskchute-docs/**",
      "tmp/**",
    ],
  },
  // Base JS recommended config
  js.configs.recommended,
  // TypeScript recommended configs for TS files
  ...tseslint.configs.recommendedTypeChecked.map(config => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  // Main source files config
  {
    files: ["src/**/*.{ts,tsx,js}"],
    plugins: {
      obsidianmd,
      import: importPlugin,
      "@microsoft/sdl": sdl,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir,
      },
      globals: sharedGlobals,
    },
    rules: {
      ...obsidianmdGeneralRules,
      ...obsidianmdRecommendedRules,
      // Additional type-aware rules (matches Obsidian review)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/unbound-method": "error",
      // Override for unused vars
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
  // English locale files - sentence case check for locale modules
  {
    files: [
      "**/en.ts",
      "**/en.js",
      "**/en-*.ts",
      "**/en-*.js",
      "**/en_*.ts",
      "**/en_*.js",
      "**/en/*.ts",
      "**/en/*.js",
      "**/locales/en.ts",
      "**/locales/en.js",
    ],
    plugins: {
      obsidianmd,
    },
    rules: {
      "obsidianmd/ui/sentence-case-locale-module": ["error", { brands: ["TaskChute", "Terminal"], acronyms: ["YYYY", "MM", "DD", "JSON", "AI"], enforceCamelCaseLower: false }],
    },
  },
  // Test files config
  {
    files: ["tests/**/*.{ts,tsx,js,jsx}", "**/*.test.{ts,tsx,js,jsx}"],
    plugins: {
      obsidianmd,
      import: importPlugin,
      "@microsoft/sdl": sdl,
    },
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
      // Disable obsidianmd rules for tests
      "obsidianmd/ui/sentence-case": "off",
    },
  },
];
