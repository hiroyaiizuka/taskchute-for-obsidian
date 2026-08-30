// The Obsidian plugin review gate.
//
// Obsidian auto-reviews every published version of a community plugin. The
// part of that review we can run ourselves is eslint-plugin-obsidianmd, which
// Obsidian publishes as the local equivalent of its guidelines. This config
// exists to run that plugin's recommended config *verbatim* — the day it is
// hand-copied here, it stops being a review and starts being a second opinion.
// eslint.config.mjs is the day-to-day lint; this one is the release gate.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import { PlainTextParser } from "eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "main.js",
      ".obsidian/**",
      "tests/**",
      "tmp/**",
      ".husky/**",
    ],
  },

  // The review criteria themselves. Never inline these rules.
  ...obsidianmd.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "eslint.review.config.mjs"],
        },
      },
    },
  },

  // The recommended config reports Node builtins through
  // obsidianmd/no-nodejs-modules, while src/ suppresses them through
  // import/no-nodejs-modules (what eslint.config.mjs enables). Leaving that
  // rule off here would make every existing directive unused, and the
  // recommended config sets reportUnusedDisableDirectives to "error".
  // Do not re-declare the `import` plugin: recommended already registers it.
  {
    files: ["src/**/*.ts"],
    rules: {
      "import/no-nodejs-modules": "error",
    },
  },

  // validate-manifest only runs when manifest.json itself is linted, so the
  // recommended config's TS/JS blocks can never reach it. Type-aware parsing
  // has to be off or the project service rejects the .json extension.
  {
    files: ["manifest.json"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false, projectService: false, program: null },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "obsidianmd/validate-manifest": "error",
    },
  },

  // Same story for validate-license, via the line-oriented parser the plugin
  // ships for exactly this purpose.
  {
    files: ["LICENSE"],
    languageOptions: { parser: PlainTextParser },
    rules: {
      "obsidianmd/validate-license": "error",
    },
  },

  // depend/ban-dependencies does not distinguish dev from prod, and moment does
  // not reach the published plugin: it is a type-only dependency the obsidian
  // typings require (esbuild marks obsidian external). Anything added here
  // needs the same kind of reason written next to it — lint-staged used to be
  // on this list and was removed instead, in favour of scripts/lint-staged.mjs.
  {
    files: ["package.json"],
    rules: {
      "depend/ban-dependencies": [
        "error",
        {
          presets: ["native", "microutilities", "preferred"],
          allowed: ["moment"],
        },
      ],
    },
  },
];
