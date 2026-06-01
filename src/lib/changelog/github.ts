import "server-only";

/**
 * GitHub-API source for /changelogs auto-entries.
 *
 * The /changelogs page surfaces one card per git commit alongside the
 * admin-curated DB entries. Historically those commit cards were baked
 * into `src/lib/changelog/recent-pushes.json` at BUILD time by
 * `scripts/generate-changelog.mjs` (wired as `prebuild`). That works
 * but it has two failure modes the user kept hitting:
 *
 *   1. Production deploys from `main`. Commits pushed to a feature
 *      branch (e.g. `claude/hungry-gould`) don't appear in prod until
 *      the branch is merged AND a fresh deploy lands.
 *   2. Even on the deployed branch, a commit pushed AFTER the last
 *      Vercel deploy doesn't show up until the next build refreshes
 *      the JSON.
 *
 * This helper hits the GitHub REST API at REQUEST time so the page
 * always reflects the latest commits on the configured branch, with
 * a short server-side cache (60-120s) wrapping the call to stay well
 * under the unauthenticated rate limit (60 req/hr) and the
 * authenticated limit (5000 req/hr).
 *
 * The JSON file remains a fully-functional fallback for any of these
 * failure modes:
 *   - `GITHUB_TOKEN` env var not set (likely on a fresh local clone
 *     before the dev sets it up)
 *   - GitHub API outage / rate-limit
 *   - Network egress blocked
 *
 * SECURITY
 * --------
 * The GitHub token is server-only (this file is `import "server-only"`).
 * We pass it via the `Authorization: Bearer ...` header — never as a
 * query parameter. The token only needs `repo:read` scope; nothing in
 * this code path mutates GitHub. We return ONLY the SHA, ISO date,
 * subject, body, and files-changed count to the caller — the commit
 * author's name / email is NOT echoed, matching the convention in
 * `scripts/generate-changelog.mjs` (the rendered author label is a
 * fixed branch string, not the git user identity).
 *
 * No external dependencies — uses the built-in `fetch` (Node 20+).
 */

/** Shape exposed to the changelog query helper. Matches the on-disk
 *  JSON entry shape one-for-one so the caller can swap sources without
 *  any further normalisation. */
export type GitHubCommitEntry = {
  sha: string;
  iso: string;
  subject: string;
  body: string;
  /** Files-changed count for this commit. `null` if the API call
   *  succeeded but the per-commit stats endpoint wasn't queried (we
   *  intentionally don't follow per-commit detail links to keep the
   *  request count at exactly one). */
  filesChanged: number | null;
};

/**
 * Mirrors the subset of the GitHub REST `/commits` list response we
 * actually consume. Typed loosely (`unknown` everywhere except the
 * fields we read) so a future API shape change can't crash the type
 * checker before we've had a chance to handle it at runtime.
 *
 * Reference: https://docs.github.com/en/rest/commits/commits#list-commits
 */
type GitHubCommitListItem = {
  sha?: unknown;
  commit?: {
    author?: { date?: unknown } | null;
    committer?: { date?: unknown } | null;
    message?: unknown;
  } | null;
};

const DEFAULT_REPO = "PackyGG/pokewin-admin";
const DEFAULT_BRANCH = "main";
const PER_PAGE = 80; // matches MAX_COMMITS in scripts/generate-changelog.mjs

/**
 * Filters mirror the build-time script so the live API path produces
 * the SAME card set the JSON would (modulo freshness). Without this,
 * tsc / lint repair commits would suddenly show up on prod that never
 * appeared via the JSON path.
 */
const SUBJECT_FILTERS: RegExp[] = [
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

function shouldKeep(subject: string): boolean {
  for (const re of SUBJECT_FILTERS) {
    if (re.test(subject)) return false;
  }
  return true;
}

/**
 * Split a commit message into `{ subject, body }`. GitHub returns the
 * full message in a single string; the first line is the subject and
 * everything after the first blank line is the body. Matches the
 * `%s` / `%b` split that `git log --pretty=format:%s%x1f%b` produces.
 */
function splitMessage(message: string): { subject: string; body: string } {
  const normalised = message.replace(/\r\n?/g, "\n");
  const newlineIdx = normalised.indexOf("\n");
  if (newlineIdx === -1) {
    return { subject: normalised.trim(), body: "" };
  }
  const subject = normalised.slice(0, newlineIdx).trim();
  // Drop leading blank line(s) between subject and body. Anything after
  // the first non-blank line counts as body even if it's an in-line
  // continuation — we don't try to be clever about it because the
  // renderer paragraphs / strips trailers downstream.
  const rest = normalised.slice(newlineIdx + 1).replace(/^\n+/, "");
  return { subject, body: rest.trim() };
}

/**
 * Fetch the latest commits on the configured branch from GitHub and
 * return them in the same shape `recent-pushes.json` would.
 *
 * Returns an empty array on ANY of the following — and never throws —
 * so the caller can fall back to the build-time JSON without a
 * try/catch:
 *   - `GITHUB_TOKEN` env var missing
 *   - API call returned non-2xx (rate limit, branch not found, auth
 *     failure, etc.)
 *   - Network error / abort
 *   - Response shape unexpected
 *
 * The 5-second timeout keeps the page render snappy on a slow / down
 * GitHub — we'd rather render the slightly-stale JSON fallback than
 * block the request for 30s waiting for `api.github.com`.
 */
export async function getLatestCommitsFromGitHub(): Promise<GitHubCommitEntry[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token || token.length === 0) {
    // No token configured — silently fall through to the JSON path.
    // This is the expected state on a fresh clone where the dev hasn't
    // set the env var yet, so don't log it.
    return [];
  }

  const repo = process.env.CHANGELOG_GIT_REPO?.trim() || DEFAULT_REPO;
  const branch = process.env.CHANGELOG_GIT_BRANCH?.trim() || DEFAULT_BRANCH;

  // Construct the URL via `URL` + `searchParams.set` instead of string
  // concatenation so any future env-var change (e.g. someone passes a
  // branch name containing `&`) can't break the query shape. `sha=`
  // accepts a branch name OR a commit SHA per the REST docs.
  const url = new URL(`https://api.github.com/repos/${repo}/commits`);
  url.searchParams.set("sha", branch);
  url.searchParams.set("per_page", String(PER_PAGE));

  // AbortController-based timeout — `fetch` doesn't have one natively.
  // 5s is well below Vercel's 10s server-function default and short
  // enough that a hung GitHub call doesn't visibly delay the page
  // render (the rest of the page still has to wait for Promise.all to
  // settle).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // No User-Agent header set — `fetch` auto-applies a node-fetch
        // / undici default that satisfies GitHub's UA requirement.
      },
      signal: controller.signal,
      // Next.js fetch caching is explicitly disabled — the caller wraps
      // us in `unstable_cache` with a 60s revalidate, and we don't want
      // the framework's default cache (which can hold stale entries
      // across revalidate windows) to interfere.
      cache: "no-store",
    });
  } catch {
    // Network error / timeout. Don't surface — fall back to JSON.
    return [];
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Non-2xx — rate limit, 404 on a missing branch, 401 on a bad
    // token, etc. All translate to "use the fallback".
    return [];
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return [];
  }

  if (!Array.isArray(json)) {
    return [];
  }

  const out: GitHubCommitEntry[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as GitHubCommitListItem;

    const sha = typeof item.sha === "string" ? item.sha : null;
    if (!sha) continue;
    // Match the build-time abbreviation length so the `version` slot
    // on each card stays consistent (7-char SHAs are what git log %h
    // produces by default).
    const shortSha = sha.slice(0, 7);

    const message =
      typeof item.commit?.message === "string" ? item.commit.message : "";
    const { subject, body } = splitMessage(message);
    if (!subject) continue;
    if (!shouldKeep(subject)) continue;

    // Prefer the author date (when the work was authored) over the
    // committer date (when it was pushed / rebased onto the branch) —
    // matches `git log --pretty=format:%aI` in the build-time script.
    const isoCandidate =
      (typeof item.commit?.author?.date === "string"
        ? item.commit.author.date
        : null) ??
      (typeof item.commit?.committer?.date === "string"
        ? item.commit.committer.date
        : null);
    if (!isoCandidate) continue;
    // Validate parseability so a malformed date can't crash the sort
    // downstream. We re-emit the canonical ISO string from `Date` so
    // the value matches what `Date.parse` would round-trip.
    const ms = Date.parse(isoCandidate);
    if (Number.isNaN(ms)) continue;
    const iso = new Date(ms).toISOString();

    out.push({
      sha: shortSha,
      iso,
      subject,
      body,
      // The list endpoint does NOT include per-commit stats; pulling
      // them would require N additional API calls (one GET per commit
      // detail link). Not worth the rate-limit cost — the renderer
      // treats `null` as "stat unavailable" and just hides the chip.
      filesChanged: null,
    });
  }

  return out;
}
