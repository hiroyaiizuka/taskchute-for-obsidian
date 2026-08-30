#!/usr/bin/env node
// Runs the Obsidian plugin review gate and reports it three ways: stylish text
// on stdout, GitHub annotations, and a job summary. Errors fail the run;
// warnings are reported and tolerated, which is how Obsidian's own review
// treats them.
//
// Three layers, in descending order of how much they can be trusted:
//
//   eslint.review.config.mjs      eslint-plugin-obsidianmd, applied verbatim.
//                                 This is Obsidian's own published config.
//   eslint.review.css.config.mjs  our reconstruction of the dashboard's CSS
//                                 findings. Validated against 2.2.2, where it
//                                 reproduces the dashboard's counts exactly.
//   obsidian-review-capabilities  the disclosures the dashboard prints for the
//                                 release artifact. Never fails the run.
//
// The dashboard additionally runs malware and dependency scans with no public
// implementation, so a clean run here is not permission to publish. Obsidian's
// own preview scan (developer dashboard, any branch/tag/commit) remains the
// only way to see the whole review.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { ESLint } from "eslint";
import { scanCapabilities } from "./obsidian-review-capabilities.mjs";

const REVIEW_CONFIG = "eslint.review.config.mjs";
const REVIEW_TARGETS = ["src", "manifest.json", "LICENSE", "package.json"];
const CSS_CONFIG = "eslint.review.css.config.mjs";
const CSS_TARGETS = ["styles.css"];
// The capability scan reads what actually ships, so it needs a build. The
// release workflow builds before this step for exactly this reason.
const BUNDLE_PATH = "main.js";
const SRC_DIR = "src";
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

function disclosureLines(disclosures) {
  return disclosures.map((disclosure) => {
    const where = disclosure.evidence
      .slice(0, 3)
      .map((item) => `${relative(item.file)}:${item.line}`)
      .join(", ");
    const rest = disclosure.evidence.length > 3
      ? ` (+${disclosure.evidence.length - 3} more)`
      : "";
    const headline = disclosure.title
      ? `${disclosure.title}: ${disclosure.detail}`
      : `Uses the Node.js ${disclosure.module} module. The dashboard's wording `
        + "for this one has not been seen, so this is our own.";
    return { headline, where: where ? `${where}${rest}` : "(not reached from src/)" };
  });
}

function writeSummary(errors, warnings, disclosures) {
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
  if (disclosures.length > 0) {
    parts.push(
      "### Capabilities disclosed to users",
      "",
      "These are not findings. Obsidian shows them to anyone deciding whether"
        + " to install, and they are derived from the built bundle.",
      "",
      "| Capability | Reached from |",
      "| --- | --- |",
      ...disclosureLines(disclosures).map(
        ({ headline, where }) => `| ${escapeCell(headline)} | ${escapeCell(where)} |`,
      ),
      "",
    );
  }
  parts.push(
    "> Only the error and warning tables come from `eslint-plugin-obsidianmd`,"
      + " the config Obsidian publishes. The CSS findings and the capability"
      + " list are reconstructions of a dashboard whose implementation is not"
      + " public, and the malware and dependency scans cannot be reproduced"
      + " here at all — so a pass is not a guarantee of publication.",
    "",
  );

  fs.appendFileSync(summaryPath, parts.join("\n"), "utf8");
}

if (!fs.existsSync(BUNDLE_PATH)) {
  process.stdout.write(
    `${BUNDLE_PATH} is missing, and the capability disclosures are read from it`
      + " rather than from src/, because that is what Obsidian reviews. Run"
      + " `npm run build` first.\n",
  );
  process.exit(1);
}

const eslint = new ESLint({ overrideConfigFile: REVIEW_CONFIG });
const cssEslint = new ESLint({ overrideConfigFile: CSS_CONFIG });
const results = [
  ...(await eslint.lintFiles(REVIEW_TARGETS)),
  ...(await cssEslint.lintFiles(CSS_TARGETS)),
];
const disclosures = scanCapabilities({
  bundlePath: BUNDLE_PATH,
  srcDir: SRC_DIR,
  builtins: new Set(builtinModules),
});

const stylish = await eslint.loadFormatter("stylish");
const rendered = await stylish.format(results);
if (rendered.trim().length > 0) {
  process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

fs.writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ findings: results, disclosures }, null, 2)}\n`,
  "utf8",
);

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

// Disclosures are printed on every run, passing or not: their whole value is
// being read when nothing is wrong, so that a new one gets noticed.
for (const { headline, where } of disclosureLines(disclosures)) {
  process.stdout.write(`disclosure: ${headline}\n  reached from ${where}\n`);
}

writeSummary(errors, warnings, disclosures);

process.stdout.write(
  `Obsidian plugin review: ${errors.length} error(s), ${warnings.length} warning(s), `
    + `${disclosures.length} capability disclosure(s); report written to ${REPORT_PATH}\n`,
);

if (errors.length > 0) {
  process.stdout.write(
    `Obsidian would not allow this version to be published. See ${GUIDELINES_URL}\n`,
  );
  process.exitCode = 1;
}
