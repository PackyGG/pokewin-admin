#!/usr/bin/env node
/**
 * generate-changelog.mjs
 *
 * Reads the last N non-merge commits from the current branch and writes
 * them to `src/lib/changelog/recent-pushes.json`. The /changelogs admin
 * page reads that file as a FALLBACK source — see the source-priority
 * note below.
 *
 * ── Source priority (as of the GitHub-API patch) ──────────────────────
 * `src/lib/queries/changelog.ts::getAutoChangelogEntries()` now tries
 * two sources, in this order:
 *
 *   1. The GitHub REST API at REQUEST time (via
 *      `src/lib/changelog/github.ts`). Wrapped in `unstable_cache` 60s
 *      so the page reflects commits pushed AFTER the last Vercel
 *      deploy — including commits on a feature branch that prod isn't
 *      deployed from. Requires `GITHUB_TOKEN` in the Vercel project env.
 *
 *   2. The build-time JSON written by THIS script. Used when the
 *      GitHub path returns nothing (token missing, API outage, rate
 *      limit, network egress blocked).
 *
 * So this script is no longer the primary source of truth — it's a
 * fallback. Keep it working anyway: a missing token shouldn't blank
 * the page, and a fresh local clone should still render commit cards
 * via `npm run dev` without setting up the env var.
 * ──────────────────────────────────────────────────────────────────────
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
 * a near-empty list and /changelogs would render "No entries yet"
 * whenever the GitHub fallback also fails.
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
 * Run `git log` and return a list of `{ sha, iso, subject, body, filesChanged }`
 * objects, newest first.
 *
 * Output format uses NUL (`\0`) as the BETWEEN-RECORD separator via `-z`,
 * and `\x1f` (ASCII unit separator) as the WITHIN-RECORD field separator.
 * This sidesteps the entire class of "commit subject contains the delimiter"
 * bugs that piped/CSV formats run into — commit subjects and bodies never
 * contain NUL or `\x1f`, but they routinely contain pipes, commas, and
 * newlines.
 *
 * Per-record layout (with `--shortstat`):
 *   <sha>\x1f<iso>\x1f<subject>\x1f<body>\x1f\n
 *    N files changed, M insertions(+), K deletions(-)\n
 *   \0
 *
 * The body field can contain newlines (commit message bodies routinely
 * do). The shortstat line is emitted by git AFTER the format expansion
 * and is the only line in the record that starts with a leading space
 * and ends in "deletions(-)", "insertions(+)", or "file changed".
 *
 * We hand the format string off as a SINGLE argv slot via execFileSync
 * (not execSync) so cmd.exe on Windows doesn't try to interpret the
 * `\x1f` / `\0` bytes — execFileSync sidesteps the shell entirely.
 */
function readCommits() {
  // %h = abbreviated SHA, %aI = author ISO-8601 strict, %s = subject,
  // %b = body. --shortstat appends "N files changed, M insertions, ..."
  // on its own line per commit. -z swaps the inter-commit newline for
  // NUL so bodies + shortstats can both contain newlines without
  // tripping the record split.
  const raw = execFileSync(
    "git",
    [
      "log",
      "-z",
      "--no-merges",
      "--shortstat",
      `-${MAX_COMMITS}`,
      "--pretty=format:%h\x1f%aI\x1f%s\x1f%b\x1f",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  const entries = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;

    // First four fields are SHA / ISO / subject / body. Anything after
    // the 4th `\x1f` is the shortstat tail (which itself contains no
    // `\x1f`, so a regular split with limit=5 captures everything).
    const fields = record.split("\x1f");
    if (fields.length < 4) continue;

    const sha = fields[0]?.trim();
    const iso = fields[1]?.trim();
    const subject = fields[2]?.trim();
    // Body trimmed of leading/trailing whitespace; an empty body is a
    // first-class signal (subject-only commit) that the renderer can
    // distinguish from missing data.
    const body = (fields[3] ?? "").trim();
    // Tail = everything after the 4th `\x1f`. With `--shortstat` this is
    // a newline + " N files changed, M insertions(+), K deletions(-)\n".
    // Without `--shortstat` (or for commits that touched zero files,
    // which `git log` skips by default) it'll be empty.
    const tail = fields.slice(4).join("\x1f");

    if (!sha || !iso || !subject) continue;
    if (!shouldKeep(subject)) continue;

    // Parse "N files changed" out of the shortstat tail. Regex is
    // permissive — git localises "file" vs "files" but never "changed"
    // in C locale builds, so anchoring on `\d+ files? changed` is safe.
    // Returns null when no shortstat is present (e.g. the JSON-only
    // initial commit that doesn't touch a tracked file).
    const filesMatch = tail.match(/(\d+)\s+files?\s+changed/);
    const filesChanged = filesMatch ? Number(filesMatch[1]) : null;

    entries.push({ sha, iso, subject, body, filesChanged });
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
