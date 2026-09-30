/**
 * CLI entry point for the browser-only gate.
 *
 * Plain JavaScript on purpose: it is the only file in the repository that touches
 * `node:fs`, and keeping it out of the TypeScript programs means the gate does not
 * force `@types/node` into `baah-web` (AGENTS.md §2's failure mode, in the very
 * package that must not have it). It is also not shipped — the rule is about the
 * runtime.
 *
 * Run: `pnpm check:browser-only`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  CAPABILITY_IDS,
  KNOWN_UNSATISFIED,
  REQUIRED,
  verifyRepository,
} from "./browser-only.ts";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "test-results", ".git", "test", "e2e"]);

/**
 * Every source under `packages/`, minus tests and build output.
 *
 * Note it walks the whole package, not just `src/`, so `vite.config.ts` is
 * included. That is deliberate — a config file is shipped code and a Node builtin
 * in it would reach the artifact. The report says how many were read, so the
 * number is never a mystery.
 */
function collectSources(root) {
  const found = {};

  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_SEGMENTS.has(entry)) continue;
      const full = join(directory, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      if (entry.includes(".test.") || entry.includes(".d.ts")) continue;
      found[relative(root, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };

  walk(join(root, "packages"));
  return found;
}

const root = process.cwd();
const report = verifyRepository(collectSources(root));

// Every problem, in one place. Printed before the summary so the last thing on
// screen is never "everything is fine" while lines scrolled past above said
// otherwise.
for (const problem of report.problems) {
  process.stdout.write(`browser-only: ${problem}\n`);
}

const satisfiedCount = CAPABILITY_IDS.length - report.missing.length;
const knownCount = report.missing.filter((id) => KNOWN_UNSATISFIED[id] !== undefined).length;

if (report.problems.length === 0) {
  process.stdout.write(
    `browser-only: ${report.filesScanned} sources in ${report.packages.length} package trees — ` +
      `no server form, ${satisfiedCount}/${CAPABILITY_IDS.length} required capabilities in use` +
      (knownCount === 0 ? "\n" : `, ${knownCount} known-unsatisfied (listed, tracked)\n`),
  );
  process.exit(0);
}

process.stdout.write(
  `browser-only: FAILED with ${report.problems.length} problem(s)\n`,
);
process.exit(1);
