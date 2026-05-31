#!/usr/bin/env node
/**
 * generate-changelog.mjs
 *
 * Reads the last N non-merge commits from the current branch and writes
 * them to `src/lib/changelog/recent-pushes.json`. The /changelogs admin
 * page reads that file at request time and renders one display entry
 * per commit alongside any admin-curated DB entries.
 *
 * Wired into `package.json` as `prebuild`, so every Vercel deploy
 * (which runs `npm run build`) refreshes the JSON automatically. The
 * file is committed to git so it's also present in local `npm run dev`
 * without an explicit regen step.
 *
 * Usage:
 *   node scripts/generate-changelog.mjs           # write the file (refuses to shrink)
 *   node scripts/generate-changelog.mjs --dry     # print to stdout
 *   node scripts/generate-changelog.mjs --force   # overwrite even if shorter
 *
 * The no-shrink guard exists because Vercel performs a shallow clone
 * (depth 1) for builds and `git log` only sees the tip commit. Without
 * the guard, every prod deploy would overwrite the committed JSON with
 * a near-empty list and /changelogs would render "No entries yet".
 *
 * NO external dependencies (uses node:child_process + node:fs only) so
 * it runs in Vercel's build sandbox without an extra install step.
 *
 * SECURITY: author info from git config is intentionally NOT echoed
 * into the JSON. We only emit the SHA, ISO date, and subject. The
 * rendered author label is the branch name string, set in the query
 * helper, not in this file.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "changelog",
  "recent-pushes.json",
);

const MAX_COMMITS = 80;
const DRY = process.argv.includes("--dry");

// Commits whose subject matches any of these patterns are filtered out.
// We keep ONLY commits that represent real shipped work — drop tooling
// noise like tsc/lint repairs, WIPs, and revert chains.
const SUBJECT_FILTERS = [
  /^fix(\(.*\))?\s*:\s*(fix\s+)?tsc/i,
  /^fix(\(.*\))?\s*:\s*(fix\s+)?lint/i,
  /^chore(\(.*\))?\s*:\s*(fix\s+)?(tsc|lint)/i,
  /^fixup!/i,
  /^squash!/i,
  /^wip\b/i,
  /^tmp\b/i,
  /^temp\b/i,
  /^\s*$/,
];

function shouldKeep(subject) {
  for (const re of SUBJECT_FILTERS) {
    if (re.test(subject)) return false;
  }
  return true;
}

/**
 * Run `git log` and return a list of `{ sha, iso, subject }` objects,
 * newest first. The pipe character is a safe delimiter because git
 * subjects in this repo don't contain it; if that ever changes,
 * `%x1f` (ASCII unit separator) is the upgrade path.
 */
function readCommits() {
  // %h = abbreviated SHA, %aI = author ISO-8601 strict, %s = subject.
  // --no-merges drops merge commits per the task spec.
  //
  // We hand the format string off as a SINGLE argv slot via execFileSync
  // (not execSync) so the pipe characters in the format aren't interpreted
  // by the host shell. cmd.exe on Windows parses unquoted `|` as a shell
  // pipe and `git log` never sees the format flag — execFileSync sidesteps
  // the shell entirely.
  const raw = execFileSync(
    "git",
    [
      "log",
      "--no-merges",
      `-${MAX_COMMITS}`,
      "--pretty=format:%h|%aI|%s",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );

  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Split on the FIRST two pipes only — the subject itself may
    // contain a pipe (unlikely but possible) and we want it preserved.
    const firstPipe = trimmed.indexOf("|");
    const secondPipe = trimmed.indexOf("|", firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) continue;

    const sha = trimmed.slice(0, firstPipe);
    const iso = trimmed.slice(firstPipe + 1, secondPipe);
    const subject = trimmed.slice(secondPipe + 1);

    if (!sha || !iso || !subject) continue;
    if (!shouldKeep(subject)) continue;

    entries.push({ sha, iso, subject });
  }

  return entries;
}

/**
 * Read the currently-committed JSON so we can compare against the
 * freshly-derived list and refuse to overwrite with a smaller / empty
 * set. Returns `null` if the file doesn't exist yet (first run) or is
 * unparseable (corrupt). Returns `[]` when the file exists but has no
 * entries — distinct from "file missing" so the caller can still treat
 * it as a meaningful zero.
 */
function readExistingEntries() {
  try {
    if (!fs.existsSync(OUTPUT_PATH)) return null;
    const raw = fs.readFileSync(OUTPUT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    console.warn(
      "[generate-changelog] could not read existing JSON, treating as missing:",
      err?.message ?? err,
    );
    return null;
  }
}

function main() {
  let entries;
  let gitFailed = false;
  try {
    entries = readCommits();
  } catch (err) {
    // If we're not in a git repo (e.g. tarball deploy), keep going —
    // the no-shrink guard below will fall back to the existing JSON.
    console.warn(
      "[generate-changelog] git log failed:",
      err?.message ?? err,
    );
    entries = [];
    gitFailed = true;
  }

  // ---- No-shrink guard --------------------------------------------------
  //
  // The script runs as `prebuild` on Vercel. Vercel performs a shallow
  // clone (default depth 1), so `git log` returns FEWER commits than
  // the full history that was used to generate the JSON locally. Without
  // this guard, Vercel would overwrite the committed 80-entry JSON with
  // a near-empty list and the /changelogs page would show "No entries
  // yet" in production.
  //
  // The committed JSON is the source of truth for prod. The rule:
  //   - If git log fails, or returns a SHORTER list than what's already
  //     committed, leave the existing JSON untouched.
  //   - Otherwise (longer or equal list — meaning we have at least as
  //     much history as before), write the fresh list.
  //
  // To force-overwrite locally pass `--force`. `--dry` still prints
  // regardless so authors can inspect what the fresh list would be.
  const existing = readExistingEntries();
  const existingCount = existing?.length ?? 0;
  const FORCE = process.argv.includes("--force");

  if (!DRY && !FORCE && entries.length < existingCount) {
    console.warn(
      `[generate-changelog] fresh list (${entries.length}) is shorter than committed JSON (${existingCount}) — keeping existing file. ` +
      (gitFailed
        ? "Reason: git log failed (likely shallow clone)."
        : "Reason: shallow clone or filtered subjects yielded fewer commits."),
    );
    console.log(
      `[generate-changelog] kept ${existingCount} commit(s) → ${path.relative(REPO_ROOT, OUTPUT_PATH)}`,
    );
    return;
  }

  const payload = {
    // Top-level metadata so the JSON is self-describing if someone
    // opens it in an editor. The query helper ignores these fields.
    generatedAt: new Date().toISOString(),
    note: "Auto-generated by scripts/generate-changelog.mjs at build time. Manual edits will be lost on next build.",
    entries,
  };

  const serialized = JSON.stringify(payload, null, 2) + "\n";

  if (DRY) {
    process.stdout.write(serialized);
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, serialized, "utf8");
  console.log(
    `[generate-changelog] wrote ${entries.length} commit(s) → ${path.relative(REPO_ROOT, OUTPUT_PATH)}`,
  );
}

main();
