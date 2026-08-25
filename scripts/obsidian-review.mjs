#!/usr/bin/env node
// Runs the Obsidian plugin review gate (eslint.review.config.mjs) and reports
// it three ways: stylish text on stdout, GitHub annotations, and a job summary.
// Errors fail the run; warnings are reported and tolerated, which is how
// Obsidian's own review treats them.
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

const REVIEW_CONFIG = "eslint.review.config.mjs";
const REVIEW_TARGETS = ["src", "manifest.json", "LICENSE", "package.json"];
const REPORT_PATH = "obsidian-review.json";
const GUIDELINES_URL =
  "https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines";

const repoRoot = process.cwd();

function relative(filePath) {
  return path.relative(repoRoot, filePath) || filePath;
}

// GitHub workflow commands are line-oriented; the payload has to be escaped or
// a message containing a newline silently truncates the annotation.
function escapeAnnotationData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeAnnotationProperty(value) {
  return escapeAnnotationData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotate(kind, file, message) {
  const properties = [
    `file=${escapeAnnotationProperty(relative(file.filePath))}`,
    `line=${message.line ?? 1}`,
    `col=${message.column ?? 1}`,
    `title=${escapeAnnotationProperty(message.ruleId ?? "obsidian-review")}`,
  ].join(",");
  process.stdout.write(
    `::${kind} ${properties}::${escapeAnnotationData(message.message)}\n`,
  );
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(rows) {
  const lines = [
    "| Rule | File | Line | Message |",
    "| --- | --- | --- | --- |",
  ];
  for (const { file, message } of rows) {
    lines.push(
      `| \`${escapeCell(message.ruleId ?? "(parse)")}\` | ${escapeCell(
        relative(file.filePath),
      )} | ${message.line ?? "-"} | ${escapeCell(message.message)} |`,
    );
  }
  return lines.join("\n");
}

function writeSummary(errors, warnings) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const parts = [
    "## Obsidian plugin review",
    "",
    `**${errors.length} error(s), ${warnings.length} warning(s)** — `
      + `[plugin guidelines](${GUIDELINES_URL})`,
    "",
    errors.length === 0
      ? "No blocking findings. Obsidian's review blocks on errors only, so this release may proceed."
      : "Errors block publication. This release was stopped.",
    "",
  ];

  if (errors.length > 0) {
    parts.push("### Errors", "", table(errors), "");
  }
  if (warnings.length > 0) {
    parts.push(
      "<details><summary>" + `${warnings.length} warning(s)` + "</summary>",
      "",
      table(warnings),
      "",
      "</details>",
      "",
    );
  }
  parts.push(
    "> This gate runs `eslint-plugin-obsidianmd`, the checks Obsidian publishes"
      + " for local use. The dashboard also runs malware and dependency scans"
      + " that cannot be reproduced here, so a pass is not a guarantee of"
      + " publication.",
    "",
  );

  fs.appendFileSync(summaryPath, parts.join("\n"), "utf8");
}

const eslint = new ESLint({ overrideConfigFile: REVIEW_CONFIG });
const results = await eslint.lintFiles(REVIEW_TARGETS);

const stylish = await eslint.loadFormatter("stylish");
const rendered = await stylish.format(results);
if (rendered.trim().length > 0) {
  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

const jsonFormatter = await eslint.loadFormatter("json");
fs.writeFileSync(REPORT_PATH, await jsonFormatter.format(results), "utf8");

const errors = [];
const warnings = [];
for (const file of results) {
  for (const message of file.messages) {
    (message.severity === 2 ? errors : warnings).push({ file, message });
  }
}

if (process.env.GITHUB_ACTIONS === "true") {
  for (const { file, message } of errors) annotate("error", file, message);
  for (const { file, message } of warnings) annotate("warning", file, message);
}

writeSummary(errors, warnings);

process.stdout.write(
  `Obsidian plugin review: ${errors.length} error(s), ${warnings.length} warning(s); report written to ${REPORT_PATH}\n`,
);

if (errors.length > 0) {
  process.stdout.write(
    `Obsidian would not allow this version to be published. See ${GUIDELINES_URL}\n`,
  );
  process.exitCode = 1;
}
