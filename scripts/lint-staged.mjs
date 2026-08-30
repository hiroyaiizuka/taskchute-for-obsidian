#!/usr/bin/env node
// The pre-commit lint gate: eslint over the staged source and test files.
//
// This replaces lint-staged, which Obsidian's plugin review flags through
// depend/ban-dependencies. The review does not distinguish dev from prod
// dependencies, so the only way to clear the finding is to not depend on the
// package at all — and the hook only ever needed "lint what is staged".
//
// Deleted and renamed-away paths are dropped (the file is gone from the work
// tree), and partially staged files are still linted whole, exactly as the
// lint-staged configuration this replaces did.
import { spawnSync } from "node:child_process";

const PATTERNS = [/^src\/.*\.(ts|tsx|js)$/, /^tests\/.*\.(ts|tsx|js)$/];

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
  .split("\0")
  .filter((file) => file.length > 0 && PATTERNS.some((pattern) => pattern.test(file)));

if (staged.length === 0) {
  process.exit(0);
}

const eslint = spawnSync(
  process.execPath,
  ["node_modules/eslint/bin/eslint.js", "--config", "eslint.config.mjs", "--no-warn-ignored", ...staged],
  { stdio: "inherit" },
);

process.exit(eslint.status ?? 1);
