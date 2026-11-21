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

// What the community scanner leaves out, so the gate can lint the whole
// repository the way the scanner does instead of only src/. 3.0.6 passed this
// gate with nothing to report and still came back with 69 warnings, because
// the scanner read the E2E suite (then at e2e/) and only src/ was linted here.
//
// The list is the one eslint-plugin-obsidianmd publishes in
// docs/configuration.md ("Community plugin scanner configuration"), except for
// the e2e entries: that list says `**/e2e/**` is skipped, but the scan of 3.0.6
// read e2e/ all the same. They are left out on purpose, so anything put in an
// e2e/ folder is reviewed here as the scanner reviewed it. Tests, the E2E suite
// included, live under tests/, which the scanner has always skipped.
const SCANNER_IGNORES = [
  "main.js",
  "**/*.min.js",
  "**/{dist,build,out,release}/**/*.{js,cjs,mjs,jsx}",
  "node_modules/**",
  "dist/**",
  "build/**",
  "pkg/**",
  "test-vault/**",
  ".obsidian/**",
  "**/.obsidian/**",
  "esbuild.config.mjs",
  "version-bump.mjs",
  "**/*.test.*",
  "**/*.tests.*",
  "**/*.spec.*",
  "**/*.specs.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/mocks/**",
  "**/__mocks__/**",
  "**/*.cjs",
  "**/*.mjs",
  "**/*.cts",
  "**/*.mts",
  "**/vite*",
  "**/scripts/**",
  "**/docs/**",
  "**/i18n/**",
  "**/i18next/**",
  "**/locale/**",
  "**/locales/**",
  "**/translations/**",
  "**/l10n/**",
  ".pnpm-store/**",
  "**/testUtils**",
  "automation/**",
  "**/wdio.conf.*",
  "**/wdio.*.conf.*",
  "**/playwright.config.*",
  "**/{astro,babel,commitlint,docusaurus,esbuild,eslint,jest,oxlint,postcss,prettier,rolldown,rollup,stylelint,svelte,tailwind,tsdown,tsup,uno,webpack}.config.*",
  "**/{eslint,jest}.*.config.*",
  "**/jest.setup.*",
  "**/.{babelrc,eslintrc,mocharc,prettierrc}.*",
];

export default [
  {
    ignores: [
      ...SCANNER_IGNORES,
      // Local only, never in the repository the scanner clones.
      "coverage/**",
      "tmp/**",
      "e2e-results/**",
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

  // The recommended config treats anything under e2e/ as a test and exempts
  // it from the rules about code that runs in Obsidian, but the scanner did
  // not: these are the rules behind 66 of 3.0.6's 69 warnings, all from e2e/.
  // Turned back on there so a suite put in e2e/ again shows up here first.
  {
    files: ["**/e2e/**/*.{ts,js}"],
    rules: {
      "obsidianmd/no-nodejs-modules": ["warn", { isDesktopOnly: false }],
      "obsidianmd/prefer-window-timers": "warn",
      "obsidianmd/hardcoded-config-path": "warn",
      "obsidianmd/prefer-create-el": "warn",
    },
  },

  // The recommended config reads manifest.json and LICENSE itself (0.5.0+),
  // but only warns on what it finds there. A broken manifest or licence is
  // refused outright, so the gate treats them as errors.
  {
    files: ["manifest.json"],
    rules: { "obsidianmd/validate-manifest": "error" },
  },
  {
    files: ["LICENSE"],
    rules: { "obsidianmd/validate-license": "error" },
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
