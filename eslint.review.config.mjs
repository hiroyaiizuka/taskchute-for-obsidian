// The Obsidian plugin review gate.
//
// Obsidian auto-reviews every published version of a community plugin. That
// review has two halves, and this config keeps them visibly apart:
//
//   1. The published half. eslint-plugin-obsidianmd is what Obsidian ships as
//      the local equivalent of its guidelines, and its recommended config is
//      applied here *verbatim* — the day it is hand-copied, it stops being a
//      review and starts being a second opinion. Which findings it produces
//      depends on the installed toolchain as much as on this file: the
//      dashboard's 36 no-unnecessary-type-assertion findings for 2.2.2 need
//      typescript-eslint 8.68 to appear at all (8.44 reports none of them), so
//      keeping the toolchain current is part of keeping the gate honest.
//   2. The reconstructed half. The dashboard's CSS analyser, capability
//      disclosures and malware/dependency scans have no public implementation.
//      What can be approximated lives in eslint.review.css.config.mjs and
//      scripts/obsidian-review-capabilities.mjs, quoting the dashboard's own
//      wording, and is marked as an approximation wherever it is reported.
//      It is kept in a separate config on purpose: the recommended config
//      above applies js.configs.recommended to every file it is asked about,
//      and those rules crash on a CSS syntax tree.
//
// So a clean run here is not permission to publish; a failing one is a
// guarantee that publishing is refused.
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
