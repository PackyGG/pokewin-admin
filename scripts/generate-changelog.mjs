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
// Per-commit file-list cap. Keeps the committed JSON bounded for a
// sweeping commit (a tree-wide refactor can touch hundreds of files).
// The renderer shows "+N more" when a commit's real file count exceeds
// what we stored. 20 is enough to convey the shape of a commit without
// bloating the payload.
const MAX_FILES_PER_COMMIT = 20;
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

// Conventional-commit subject matcher — used to pull the (scope) out of
// e.g. `feat(insights/games): foo`. Mirrors the runtime regex in
// `src/lib/queries/changelog.ts::CONVENTIONAL_RE` (kept in sync by
// hand — both are intentionally narrow). Group 3 is the scope.
const CONVENTIONAL_RE =
  /^(feat|fix|perf|refactor|chore|docs|style|test|build|ci|revert|nav|ux)(\(([^)]*)\))?\s*:\s*(.+)$/i;

/**
 * Pull the conventional-commit scope out of a subject. Returns null when
 * the subject isn't conventional or has no `(scope)` segment.
 *   "feat(insights/games): foo" → "insights/games"
 *   "nav: move thing"            → null
 *   "plain subject"              → null
 */
function parseScope(subject) {
  const m = subject.match(CONVENTIONAL_RE);
  const scope = m?.[3]?.trim();
  return scope && scope.length > 0 ? scope : null;
}

/**
 * Run `git log` and return a list of
 * `{ sha, iso, subject, body, filesChanged, additions, deletions, files }`
 * objects, newest first.
 *
 * Records are delimited by `\x1e` (ASCII RECORD separator) emitted at
 * the START of each commit's pretty-format, and fields WITHIN the
 * pretty-format by `\x1f` (ASCII UNIT separator). Commit subjects and
 * bodies never contain `\x1e` / `\x1f` but routinely contain pipes,
 * commas, tabs, and newlines — so this sidesteps the entire class of
 * "delimiter appears in the message" bugs.
 *
 * We run TWO `git log` passes and merge them by SHA:
 *
 *   1. `--name-status` — gives the per-file STATUS letter (A/M/D/R/…)
 *      and path, plus the subject / body / iso fields.
 *   2. `--numstat`     — gives `<added>\t<deleted>\t<path>` per file.
 *
 * Git applies only ONE diff-output format per invocation (the last
 * `--name-status` / `--numstat` / `--shortstat` wins), so a single pass
 * CANNOT yield both the status letter AND the +/- counts. Rather than
 * GUESS a status from numstat (ambiguous: `12\t0\tx` could be an add or
 * a modify), we take the status from pass 1 and the counts from pass 2
 * and join on `(sha, path)`. Both passes are local, run once at build
 * time, so the doubled `git log` cost is negligible.
 *
 * We deliberately DON'T use `git log -z`: with `-z`, the diff formats
 * switch to NUL-delimited path output which collides with the
 * inter-record NUL. Without `-z` the formats stay newline/tab
 * delimited, and the `\x1e` record sentinel handles the multi-line
 * body block.
 *
 * Per-record layout (pass 1, `--name-status`):
 *   \x1e<sha>\x1f<iso>\x1f<subject>\x1f<body>\x1f\n
 *   M\tpath/one\n
 *   A\tpath/two\n
 *   R100\told/path\tnew/path\n
 *
 * Per-record layout (pass 2, `--numstat`):
 *   \x1e<sha>\n
 *   12\t3\tpath/one\n
 *   40\t0\tpath/two\n
 *   -\t-\tpath/binary\n          (binary files report "-" for both)
 *
 * We hand the format string off as a SINGLE argv slot via execFileSync
 * (not execSync) so cmd.exe on Windows doesn't try to interpret the
 * `\x1e` / `\x1f` bytes — execFileSync sidesteps the shell entirely.
 */
function readCommits() {
  // ---- Pass 2 first: numstat counts keyed by SHA → Map<sha, …> --------
  // Built before the primary pass so the primary loop can look up counts
  // as it assembles each entry.
  const numstatBySha = readNumstat();

  // ---- Pass 1: name-status (primary — subject/body/iso/files+status) --
  // %h = abbreviated SHA, %aI = author ISO-8601 strict, %s = subject,
  // %b = body. A leading %x1e marks the start of each record so the
  // multi-line body block can't be mistaken for a new commit.
  const raw = execFileSync(
    "git",
    [
      "log",
      "--no-merges",
      "--name-status",
      `-${MAX_COMMITS}`,
      "--pretty=format:%x1e%h\x1f%aI\x1f%s\x1f%b\x1f",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  const entries = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;

    // First four fields are SHA / ISO / subject / body. Anything after
    // the 4th `\x1f` is the name-status tail (which itself contains no
    // `\x1f`, so a regular split captures everything).
    const fields = record.split("\x1f");
    if (fields.length < 4) continue;

    const sha = fields[0]?.trim();
    const iso = fields[1]?.trim();
    const subject = fields[2]?.trim();
    // Body trimmed of leading/trailing whitespace; an empty body is a
    // first-class signal (subject-only commit) that the renderer can
    // distinguish from missing data.
    const body = (fields[3] ?? "").trim();
    // Tail = everything after the 4th `\x1f`: the newline-delimited
    // `<STATUS>\t<path>` lines. Empty for a commit that touched zero
    // tracked files.
    const tail = fields.slice(4).join("\x1f");

    if (!sha || !iso || !subject) continue;
    if (!shouldKeep(subject)) continue;

    const statusFiles = parseNameStatus(tail);
    const numstat = numstatBySha.get(sha) ?? null;

    // Merge per-file counts (pass 2) onto the status list (pass 1) by
    // path. A path present in name-status but missing from numstat
    // (shouldn't happen, but defends against a parse edge) keeps null
    // counts. `filesChanged` = TRUE file count (pre-cap) so the renderer
    // can show an accurate "+N more".
    const totalFiles = statusFiles.length;
    const files = statusFiles.slice(0, MAX_FILES_PER_COMMIT).map((f) => {
      const counts = numstat?.perFile.get(f.path);
      return {
        path: f.path,
        status: f.status,
        additions: counts ? counts.additions : null,
        deletions: counts ? counts.deletions : null,
      };
    });

    entries.push({
      sha,
      iso,
      subject,
      body,
      filesChanged: totalFiles > 0 ? totalFiles : null,
      additions: numstat ? numstat.additions : null,
      deletions: numstat ? numstat.deletions : null,
      files,
      scope: parseScope(subject),
    });
  }

  return entries;
}

/**
 * Pass 2: read `git log --numstat` and return a
 * `Map<sha, { additions, deletions, perFile: Map<path, {additions, deletions}> }>`.
 *
 * numstat line shape: `<added>\t<deleted>\t<path>`. Binary files report
 * `-` for both counts — we treat those as 0 for the per-file +/- (a
 * binary blob has no meaningful line count) but they still count toward
 * `filesChanged` via the name-status pass.
 *
 * Rename lines can appear as `<a>\t<d>\t{old => new}` or
 * `<a>\t<d>\told\tnew` depending on git config; we normalise the path to
 * the post-commit form so it joins against the name-status destination
 * path. A rename with no content change shows `0\t0\t…` and is skipped
 * from the per-file map (no counts to show) but its rollup adds zero.
 */
function readNumstat() {
  const out = new Map();
  let raw;
  try {
    raw = execFileSync(
      "git",
      [
        "log",
        "--no-merges",
        "--numstat",
        `-${MAX_COMMITS}`,
        "--pretty=format:%x1e%h",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    // If the numstat pass fails for any reason, the primary pass still
    // produces entries — just without +/- counts. Counts are an
    // enhancement, not load-bearing.
    return out;
  }

  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const sha = lines.shift()?.trim();
    if (!sha) continue;

    let additions = 0;
    let deletions = 0;
    const perFile = new Map();

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim() === "") continue;
      // `<added>\t<deleted>\t<path…>` — split on the FIRST two tabs only
      // so a path containing a tab (rare but legal) stays intact.
      const firstTab = line.indexOf("\t");
      if (firstTab === -1) continue;
      const secondTab = line.indexOf("\t", firstTab + 1);
      if (secondTab === -1) continue;
      const addStr = line.slice(0, firstTab);
      const delStr = line.slice(firstTab + 1, secondTab);
      let pathField = line.slice(secondTab + 1);

      // Binary files: "-" for both counts. Count as 0 lines.
      const add = addStr === "-" ? 0 : Number(addStr);
      const del = delStr === "-" ? 0 : Number(delStr);
      if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
      additions += add;
      deletions += del;

      // Normalise a `{old => new}` rename token to the destination path
      // so it joins the name-status `R<score>\told\tnew` (dest) path.
      const braceRename = pathField.match(/\{.*? => (.*?)\}/);
      if (braceRename) {
        pathField = pathField.replace(/\{.*? => (.*?)\}/, "$1").replace(/\/\//g, "/");
      }
      const path = pathField.trim();
      if (path) perFile.set(path, { additions: add, deletions: del });
    }

    out.set(sha, { additions, deletions, perFile });
  }

  return out;
}

/**
 * Parse the per-commit name-status tail into `[{ path, status }]` (full,
 * uncapped — the caller applies MAX_FILES_PER_COMMIT after merging
 * counts so the TRUE file count is preserved for "+N more").
 *
 * name-status line: "<STATUS>\t<path>" — STATUS is a single letter
 * optionally followed by a similarity score (e.g. `R100`). Rename / copy
 * entries carry "<STATUS>\t<old>\t<new>"; we record the NEW path (the
 * last tab field) since that's the file that exists post-commit.
 */
function parseNameStatus(tail) {
  const files = [];
  if (!tail) return files;
  for (const rawLine of tail.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    // Tab-split so a path containing spaces stays intact.
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0].trim();
    if (!/^[A-Z]/.test(status)) continue; // not a status line
    // Rename/copy: take the destination path (last field). Otherwise the
    // single path field.
    const path = (parts[parts.length - 1] ?? "").trim();
    if (!path) continue;
    files.push({ path, status });
  }
  return files;
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
