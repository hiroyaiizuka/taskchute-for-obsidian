// The capability disclosures the Obsidian dashboard prints for this plugin.
//
// Those lines are not lint findings and have no public implementation: the
// dashboard derives them from the release artifact, which is why they name
// capabilities (`fs`, `child_process`) that src/ reaches only through
// `require`. This module reconstructs them from the built bundle for the same
// reason -- what ships is what gets reviewed -- and points at the src/ lines
// responsible so the disclosure is actionable rather than merely alarming.
//
// A disclosure is not a finding. Obsidian does not refuse a plugin for having
// these capabilities; it tells users about them. So this never fails the gate.
// What it is for: noticing the day a capability appears that nobody meant to
// ship.
import fs from "node:fs";
import path from "node:path";

// Wording copied from the dashboard's own report for taskchute-plus 2.2.2.
// Anything not in this table is still reported, just without their phrasing --
// inventing an official-sounding sentence for it would be worse than saying
// plainly that we do not know how they word it.
const KNOWN_CAPABILITIES = new Map([
  [
    "fs",
    {
      title: "Direct Filesystem Access",
      detail:
        "Uses the Node.js fs module to access the filesystem outside of the Obsidian vault API. Can read and write any file on the system.",
    },
  ],
  [
    "child_process",
    {
      title: "Shell Execution",
      detail:
        "Executes shell commands via child_process. Gives the plugin full control over the system.",
    },
  ],
]);

// `require("fs")`, `require('node:fs')`, `from "child_process"`, and the
// import-expression form. esbuild leaves all of them as literals, so a regex
// over the bundle is enough; a parse would buy nothing on 3 MB of output.
const MODULE_REFERENCE =
  /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"']+)["']/g;

function normalize(specifier) {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

function collectModules(source) {
  const found = new Map();
  for (const match of source.matchAll(MODULE_REFERENCE)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const name = normalize(specifier);
    found.set(name, (found.get(name) ?? 0) + 1);
  }
  return found;
}

function listSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

// Which src/ lines put the capability in the bundle. Comments mentioning a
// module are not evidence, so only lines that actually reference it as a
// module specifier count.
function findEvidence(srcDir, moduleName) {
  if (!fs.existsSync(srcDir)) return [];
  const evidence = [];
  for (const file of listSourceFiles(srcDir)) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(MODULE_REFERENCE)) {
        const specifier = match[1] ?? match[2];
        if (specifier && normalize(specifier) === moduleName) {
          evidence.push({ file, line: index + 1 });
        }
      }
    });
  }
  return evidence;
}

/**
 * Reads the built bundle and returns the capabilities it discloses.
 *
 * @param {{ bundlePath: string, srcDir: string, builtins: Set<string> }} options
 * @returns {{ module: string, title: string|null, detail: string|null, occurrences: number, evidence: { file: string, line: number }[] }[]}
 */
export function scanCapabilities({ bundlePath, srcDir, builtins }) {
  const bundle = fs.readFileSync(bundlePath, "utf8");
  const disclosures = [];

  for (const [name, occurrences] of collectModules(bundle)) {
    if (!builtins.has(name)) continue;
    const known = KNOWN_CAPABILITIES.get(name);
    disclosures.push({
      module: name,
      title: known?.title ?? null,
      detail: known?.detail ?? null,
      occurrences,
      evidence: findEvidence(srcDir, name),
    });
  }

  // Named capabilities first -- those are the ones the dashboard puts in front
  // of a user deciding whether to install.
  return disclosures.sort((a, b) => {
    if (Boolean(a.title) !== Boolean(b.title)) return a.title ? -1 : 1;
    return a.module.localeCompare(b.module);
  });
}
