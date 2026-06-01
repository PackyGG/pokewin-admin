import {
  AlertTriangle,
  Archive,
  ChevronDown,
  FileText,
  FolderTree,
  GitCommit,
  List,
  Radio,
  Server,
  ScrollText,
  Sparkles,
  Tag,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  formatDateTime,
  formatNumber,
  formatRelativeStrict,
} from "@/lib/utils/format";
import { ensureChangelogSchema } from "@/lib/changelog/ensure-schema";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getAutoChangelogEntries,
  getChangelogEntries,
  getChangelogStats,
  isAutoChangelogEntry,
  type AutoChangelogResult,
  type ChangelogCategory,
  type ChangelogChangeKind,
  type ChangelogEntry,
  type ChangelogFile,
} from "@/lib/queries/changelog";
import {
  resolveChangelogBranch,
  resolveChangelogRepo,
} from "@/lib/changelog/github";
import { cn } from "@/lib/utils";

import {
  EditChangelogEntryButton,
  NewChangelogEntryButton,
} from "./changelog-form-dialog";
import { ChangelogSummary } from "./changelog-summary";
import { DeleteChangelogButton } from "./delete-changelog-button";
import { SeedChangelogButton } from "./seed-changelog-button";

export const metadata = { title: "Changelogs" };

// ---------------------------------------------------------------------------
// Cosmetic helpers — category and change-kind badge + icon mapping. Lives
// alongside the page so the card layout has direct access without crossing
// the RSC / client boundary. House-POV color rule does not apply here:
// changelog is informational, not financial.
//
// Categories follow the rule of thumb agreed in the task description:
//   feature      → emerald (positive, additive)
//   improvement  → blue    (positive, refinement)
//   fix          → amber   (warning-adjacent, drawing attention)
//   breaking     → rose    (loud, action-required signal)
//   infra        → neutral (gray — under-the-hood, not user-facing)
// ---------------------------------------------------------------------------

const CATEGORY_BADGE_CLASS: Record<ChangelogCategory, string> = {
  feature:
    "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  improvement:
    "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400",
  fix: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
  breaking:
    "bg-rose-500/15 text-rose-600 border-rose-500/30 dark:text-rose-400",
  infra:
    "bg-muted text-muted-foreground border-border",
};

const CATEGORY_ICON: Record<ChangelogCategory, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CATEGORY_LABEL: Record<ChangelogCategory, string> = {
  feature: "Feature",
  improvement: "Improvement",
  fix: "Fix",
  breaking: "Breaking",
  infra: "Infra",
};

const CHANGE_KIND_ICON: Record<ChangelogChangeKind, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CHANGE_KIND_COLOR: Record<ChangelogChangeKind, string> = {
  feature: "text-emerald-500",
  improvement: "text-blue-500",
  fix: "text-amber-500",
  breaking: "text-rose-500",
  infra: "text-muted-foreground",
};

// File-status letter → short label + dot color for the Files disclosure.
// Keyed on the FIRST letter of the git status (A/M/D/R/C/T/…) so a
// similarity-scored status like "R100" still maps. Colors are
// informational (git semantics), NOT the house-POV financial palette —
// added=green, modified=amber, deleted=rose, rename/other=muted.
const FILE_STATUS_META: Record<string, { label: string; dot: string }> = {
  A: { label: "added", dot: "bg-emerald-500" },
  M: { label: "modified", dot: "bg-amber-500" },
  D: { label: "deleted", dot: "bg-rose-500" },
  R: { label: "renamed", dot: "bg-blue-500" },
  C: { label: "copied", dot: "bg-blue-500" },
  T: { label: "type", dot: "bg-muted-foreground" },
};

function fileStatusMeta(status: string): { label: string; dot: string } {
  const first = status.trim().charAt(0).toUpperCase();
  return FILE_STATUS_META[first] ?? { label: status, dot: "bg-muted-foreground" };
}

/**
 * Group a commit's touched files by top-level area for the Files
 * disclosure, matching the area vocabulary the per-change fallback uses
 * (admin route segment for `src/app/(admin)/...`, flat label otherwise).
 * Pure presentation — kept here next to the renderer rather than crossing
 * the RSC boundary. Returns areas ordered by descending file count.
 */
const FILE_AREA_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "src/app/(auth)/", label: "Auth pages" },
  { prefix: "src/components/data-table/", label: "Data tables" },
  { prefix: "src/components/ui/", label: "UI primitives" },
  { prefix: "src/components/", label: "Components" },
  { prefix: "src/lib/queries/", label: "Queries" },
  { prefix: "src/lib/changelog/", label: "Changelog" },
  { prefix: "src/lib/utils/", label: "Utilities" },
  { prefix: "src/lib/", label: "Library" },
  { prefix: "src/hooks/", label: "Hooks" },
  { prefix: "prisma/admin/", label: "Admin database" },
  { prefix: "prisma/", label: "Database" },
  { prefix: "scripts/", label: "Scripts" },
  { prefix: "public/", label: "Public assets" },
  { prefix: ".github/", label: "CI" },
  { prefix: "src/", label: "App" },
];

function fileAreaLabel(path: string): string {
  const adminMatch = path.match(/^src\/app\/\(admin\)\/([^/]+)(?:\/([^/]+))?/);
  if (adminMatch) {
    const titleize = (s: string) =>
      s.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    const top = adminMatch[1];
    const sub = adminMatch[2];
    if (sub && !sub.startsWith("[") && !sub.startsWith("_")) {
      return `${titleize(top)} / ${titleize(sub)}`;
    }
    return titleize(top);
  }
  for (const { prefix, label } of FILE_AREA_LABELS) {
    if (path.startsWith(prefix)) return label;
  }
  return path.includes("/") ? "Other" : "Project";
}

function groupFilesByArea(
  files: ChangelogFile[],
): Array<{ area: string; files: ChangelogFile[] }> {
  const map = new Map<string, ChangelogFile[]>();
  for (const f of files) {
    const area = fileAreaLabel(f.path);
    const list = map.get(area);
    if (list) list.push(f);
    else map.set(area, [f]);
  }
  return [...map.entries()]
    .map(([area, list]) => ({ area, files: list }))
    .sort((a, b) => b.files.length - a.files.length);
}

/** Strip the area-relevant leading path so the file row shows the
 *  distinctive tail (basename + one parent) instead of the full
 *  `src/app/(admin)/…` prefix repeated on every row. */
function shortFilePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ChangelogsPage() {
  const session = await requirePageAccess("/changelogs");

  // Self-heal the table on every render — IF-NOT-EXISTS so this is a
  // no-op after the first hit on a given server process. Same pattern as
  // the employee board / salaries surfaces.
  await ensureChangelogSchema();

  const isAdmin = session.role === "admin";
  let canManage = isAdmin;
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canManage = hasCapability(perms, "__can_manage_changelog");
  }

  // Fetch admin-curated DB entries + auto-generated commit entries in
  // parallel. Both are wrapped in safeQuery so a failure on one side
  // (e.g. JSON file missing on a fresh clone, admin DB hiccup) doesn't
  // blank the whole page — the working side still renders.
  //
  // The auto-entries fallback is a fully-populated `AutoChangelogResult`
  // (not bare `[]`) so the diagnostic chip + panel always have something
  // sensible to read even when `getAutoChangelogEntries()` itself
  // throws. We tag the synthetic fallback `"json-fallback"` so the chip
  // amber-warns the admin that the surface is degraded.
  const [
    { data: dbEntries },
    { data: autoResult },
    { data: stats },
  ] = await Promise.all([
    safeQuery(
      () => getChangelogEntries({ limit: 100 }),
      [] as ChangelogEntry[],
      "changelogs.db-entries",
    ),
    safeQuery<AutoChangelogResult>(
      () => getAutoChangelogEntries(),
      {
        entries: [],
        source: "json-fallback",
        branch: null,
        lastFetchAt: new Date().toISOString(),
        lastError: "getAutoChangelogEntries threw",
        tokenConfigured: false,
      },
      "changelogs.auto-entries",
    ),
    safeQuery(
      () => getChangelogStats(),
      { totalEntries: 0, thisMonthEntries: 0, lastPublishedAt: null },
      "changelogs.stats",
    ),
  ]);

  // Merge — DB entries first to match the (rare) ordering tie where an
  // admin publishes a curated entry at the exact same instant as a
  // commit. Sort descending by publishedAt, newest first.
  const entries: ChangelogEntry[] = [...dbEntries, ...autoResult.entries].sort(
    (a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0),
  );

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ScrollText}
          accent="purple"
          title="Changelogs"
          subtitle="What's new in the admin panel and the platform."
          action={
            canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <SeedChangelogButton />
                <NewChangelogEntryButton />
              </div>
            ) : null
          }
        />
      </PageHero>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiTile
          label="Total entries"
          value={formatNumber(stats.totalEntries)}
          icon={ScrollText}
          accent="purple"
        />
        <KpiTile
          label="Last published"
          // Lead with the precise absolute timestamp ("Jun 1, 2026 01:46")
          // — the old relative-only display ("about 13 hours ago") read
          // like a broken value because it never resolved into anything
          // an admin could correlate with a commit log. Fine-grained
          // relative moves to the sub line, using the strict variant so
          // there's no fuzzy "about" prefix.
          value={
            stats.lastPublishedAt ? formatDateTime(stats.lastPublishedAt) : "—"
          }
          sub={
            stats.lastPublishedAt
              ? formatRelativeStrict(stats.lastPublishedAt)
              : "No entries yet"
          }
          icon={Sparkles}
          accent="emerald"
          // Auto-generated commit cards come from the GitHub REST API
          // at request time (cached 60s) when `GITHUB_TOKEN` is set in
          // the Vercel env. Without the token the page falls back to
          // the build-time JSON at `src/lib/changelog/recent-pushes.json`
          // (regenerated by `scripts/generate-changelog.mjs` as the
          // `prebuild` step). The status chip below makes which path
          // is active visible from the page — green "Live (GitHub)"
          // when the API responded, amber "Snapshot (build-time)" when
          // we're on the JSON fallback (with the failure reason in the
          // tooltip so a stale tile is explicable, not mysterious).
          action={<ChangelogSourceChip result={autoResult} />}
        />
      </div>

      <SectionHeading icon={List} title="Releases" />

      {entries.length === 0 ? (
        <StatPanel title="No entries yet" icon={ScrollText} accent="purple">
          <EmptyState
            icon={ScrollText}
            title="No entries yet"
            description={
              canManage
                ? "Click + New entry to publish your first changelog."
                : "An admin will publish release notes here as the platform ships updates."
            }
            accent="purple"
          />
        </StatPanel>
      ) : (
        <FadeIn>
          <div className="space-y-4">
            {entries.map((entry) => (
              <ChangelogCard
                key={entry.id}
                entry={entry}
                canManage={canManage}
              />
            ))}
          </div>
        </FadeIn>
      )}

      {isAdmin && <ChangelogDiagnosticsPanel result={autoResult} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source chip — green "Live (GitHub)" / amber "Snapshot (build-time)"
// ---------------------------------------------------------------------------

/**
 * Visible at-a-glance indicator of which data source is feeding the
 * commit cards on this page. Lives in the Last published tile action
 * slot so it sits right next to the timestamp the admin is reading.
 *
 * Two states only — the underlying source enum has three values
 * (`"github"` / `"json"` / `"json-fallback"`) but the user only cares
 * "live or stale". The tooltip carries the nuance (no-token vs
 * call-failed) including the short error tag when applicable, so an
 * admin debugging a stale "Last published" can read the chip + the
 * tooltip and know exactly which knob to turn.
 */
function ChangelogSourceChip({ result }: { result: AutoChangelogResult }) {
  if (result.source === "github") {
    const branchLabel = result.branch ?? "(unknown)";
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400"
        title={`Live commit history from the GitHub REST API. Branch: ${branchLabel}. Refresh cadence: 60s.`}
        aria-label="Source: live GitHub feed"
      >
        <Radio className="size-3" />
        Live (GitHub)
      </span>
    );
  }

  // json or json-fallback — same amber visual, different tooltip so
  // the admin can tell whether the token is missing vs the call failed.
  const tooltip =
    result.source === "json"
      ? "Reading from the build-time JSON snapshot — commits pushed after the last Vercel deploy won't appear until the next build. Set GITHUB_TOKEN in the Vercel project env to switch to the live feed."
      : `GitHub API was attempted but didn't return entries (${result.lastError ?? "unknown"}). Falling back to the build-time JSON snapshot. Check the token scope, branch name (${result.branch ?? "(none)"}), and rate limit.`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400"
      title={tooltip}
      aria-label="Source: build-time snapshot"
    >
      <Archive className="size-3" />
      Snapshot (build-time)
    </span>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics panel — admin only
// ---------------------------------------------------------------------------

/**
 * Collapsible diagnostic panel rendered under the entries list, ONLY
 * for admin sessions. Shows the exact state of the GitHub fetch so
 * an admin can answer "why is the page stale?" without poking around
 * the env vars by hand:
 *
 *   - Token configured: yes/no
 *   - Branch read: <name>
 *   - Repo: <slug>
 *   - Last fetch: <ISO>
 *   - Source: github | json | json-fallback
 *   - Last error: <message or "none">
 *   - Cache TTL: 60s
 *
 * The default-closed `<details>` matches the existing disclosure
 * pattern used elsewhere (`creators/_components/multiplier-review`).
 * Repo / branch labels come from the public env vars (no secrets are
 * read or echoed). Token is reported as a boolean only — never the
 * value itself.
 */
function ChangelogDiagnosticsPanel({ result }: { result: AutoChangelogResult }) {
  // Repo + branch resolution funnels through the SAME helpers the
  // fetcher uses so the panel can never disagree with what the live
  // API path would query. In the no-token state `result.branch` is
  // null on purpose (no call was made) — fall back to the env-resolved
  // branch so the row shows what WOULD be used the moment the token
  // is configured, which is what an admin is debugging.
  const repo = resolveChangelogRepo();
  const branch = result.branch ?? resolveChangelogBranch();

  return (
    <details className="group surface-sheen relative overflow-hidden rounded-xl border bg-muted/10 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <Server className="size-3.5" />
          Diagnostics (admin only)
        </span>
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <DiagnosticRow
          label="Token configured"
          value={result.tokenConfigured ? "yes" : "no"}
          tone={result.tokenConfigured ? "ok" : "warn"}
        />
        <DiagnosticRow label="Branch read" value={branch} />
        <DiagnosticRow label="Repo" value={repo} />
        <DiagnosticRow label="Last fetch" value={result.lastFetchAt} mono />
        <DiagnosticRow
          label="Source"
          value={result.source}
          tone={result.source === "github" ? "ok" : "warn"}
        />
        <DiagnosticRow
          label="Last error"
          value={result.lastError ?? "none"}
          tone={result.lastError ? "warn" : "ok"}
        />
        <DiagnosticRow label="Cache TTL" value="60s" />
      </dl>
    </details>
  );
}

/**
 * Single key/value row inside the diagnostics panel. `tone` flips the
 * value color so failures stand out without making the panel busy.
 */
function DiagnosticRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "warn";
}) {
  const valueColor =
    tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : tone === "ok"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-foreground";
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/30 py-1 last:border-b-0 sm:border-b">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right font-medium",
          valueColor,
          mono && "font-mono text-[11px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function ChangelogCard({
  entry,
  canManage,
}: {
  entry: ChangelogEntry;
  canManage: boolean;
}) {
  // Auto entries (one per git commit) use a git icon in place of the
  // category icon, surface the short SHA as the version slot, and have
  // their edit / delete buttons hidden because they're owned by git,
  // not by the admin DB. The category badge palette still applies so
  // feat / fix / etc. stay visually distinguishable.
  const isAuto = isAutoChangelogEntry(entry);
  const CategoryIcon = isAuto ? GitCommit : CATEGORY_ICON[entry.category];
  return (
    <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
      {/* Hairline top highlight to match the modern-panel family. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="relative p-4 sm:p-5 space-y-4">
        {/* Top row: date + version + category badge + optional files-changed
            chip + optional auto pill */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Minute-precision absolute timestamp + a strict relative pill
              ("13 hours ago", no fuzzy "about" prefix). The old
              day-precision `formatDate` here lost too much fidelity for
              freshly-shipped commits — two cards from the same morning
              looked identical even when they were hours apart. */}
          <span
            className="font-medium text-muted-foreground"
            title={formatRelativeStrict(entry.publishedAt)}
          >
            {formatDateTime(entry.publishedAt)}
          </span>
          <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">
            {formatRelativeStrict(entry.publishedAt)}
          </span>
          {entry.version && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {isAuto ? (
                <GitCommit className="size-3" />
              ) : (
                <Tag className="size-3" />
              )}
              {entry.version}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
              CATEGORY_BADGE_CLASS[entry.category],
            )}
          >
            <CategoryIcon className="size-3" />
            {CATEGORY_LABEL[entry.category]}
          </span>
          {/* Area / scope badge — the conventional-commit (scope), e.g.
              "insights/games", parsed upstream. Sits next to the category
              badge so the admin can scan which surface a commit touched at
              a glance. Only present on auto entries that carried a scope. */}
          {isAuto && entry.scope && (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-purple-600 dark:text-purple-400"
              title={`Area: ${entry.scope} (parsed from the commit scope)`}
            >
              <FolderTree className="size-3" />
              {entry.scope}
            </span>
          )}
          {isAuto && typeof entry.filesChanged === "number" &&
            entry.filesChanged > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
                title={`${entry.filesChanged} file${entry.filesChanged === 1 ? "" : "s"} changed in this commit`}
              >
                <FileText className="size-3" />
                {entry.filesChanged}{" "}
                {entry.filesChanged === 1 ? "file" : "files"}
              </span>
            )}
          {isAuto && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              title="Auto-generated from a git commit. Not editable in the admin panel."
            >
              auto
            </span>
          )}
        </div>

        {/* Title + summary. ChangelogSummary handles the long-text
            collapse / "show more" disclosure client-side; short summaries
            render inline without the toggle. */}
        <div className="space-y-1.5">
          <h3 className="text-lg font-semibold tracking-tight">{entry.title}</h3>
          {entry.summary && <ChangelogSummary text={entry.summary} />}
        </div>

        {/* Changes — the per-change explanation. Admin-curated entries
            carry these from the DB; auto (git) entries now derive them
            from the commit body (bullets / paragraphs) with a file-area
            fallback, so each commit explains itself change-by-change. The
            "Changes" label only shows on auto cards to distinguish the
            derived list from a curator's hand-written bullets. */}
        {entry.changes.length > 0 && (
          <div className="space-y-1.5">
            {isAuto && (
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Changes
              </p>
            )}
            <ul className="space-y-1.5">
              {entry.changes.map((change, idx) => {
                const Icon = CHANGE_KIND_ICON[change.kind];
                return (
                  <li
                    key={idx}
                    className="flex items-start gap-2 text-sm"
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        CHANGE_KIND_COLOR[change.kind],
                      )}
                    />
                    <span className="min-w-0 flex-1">{change.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Files disclosure — collapsible list of touched file paths,
            grouped by area, with per-file +adds / −dels when the source
            carried them (build-time JSON path; the live GitHub list path
            omits per-file data). Only on auto cards that captured files. */}
        {isAuto && entry.files && entry.files.length > 0 && (
          <ChangelogFilesDisclosure
            files={entry.files}
            totalFiles={entry.filesChanged ?? entry.files.length}
            additions={entry.additions ?? null}
            deletions={entry.deletions ?? null}
          />
        )}

        {/* Footer: author + admin actions (only on DB-curated entries) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground">
          <span>
            {entry.author.username
              ? <>by <span className="font-medium text-foreground">{entry.author.username}</span></>
              : "by (unknown admin)"}
          </span>
          {canManage && !isAuto && (
            <div className="flex items-center gap-1">
              <EditChangelogEntryButton entry={entry} />
              <DeleteChangelogButton id={entry.id} title={entry.title} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files disclosure — collapsible, grouped-by-area touched-file list
// ---------------------------------------------------------------------------

/**
 * Native `<details>` disclosure listing the files a commit touched,
 * grouped by area and ordered by churn. Each file row shows a status dot
 * (added / modified / deleted / renamed) + the distinctive path tail +
 * per-file +adds / −dels when available. The summary line carries the
 * total file count + the commit-level +/- rollup so the admin gets the
 * headline without expanding.
 *
 * When the stored file list is shorter than the TRUE file count (the
 * generator caps at 20 per commit to bound the JSON), a "+N more" row
 * makes the truncation explicit rather than silently dropping files.
 *
 * Pure Server Component — `<details>` handles open/close with zero JS,
 * matching the diagnostics panel disclosure above. The +/- coloring is
 * git-semantic (added=emerald, deleted=rose), NOT the house-POV financial
 * palette — changelog file churn isn't a money signal.
 */
function ChangelogFilesDisclosure({
  files,
  totalFiles,
  additions,
  deletions,
}: {
  files: ChangelogFile[];
  totalFiles: number;
  additions: number | null;
  deletions: number | null;
}) {
  const groups = groupFilesByArea(files);
  const hiddenCount = Math.max(0, totalFiles - files.length);
  const hasDiffStat =
    typeof additions === "number" && typeof deletions === "number";

  return (
    <details className="group rounded-xl border border-border/60 bg-muted/10 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <FileText className="size-3.5" />
          {totalFiles} {totalFiles === 1 ? "file" : "files"} changed
          {hasDiffStat && (additions > 0 || deletions > 0) && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{formatNumber(additions)}
              </span>
              <span className="text-rose-600 dark:text-rose-400">
                −{formatNumber(deletions)}
              </span>
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <div className="mt-2.5 space-y-3">
        {groups.map((group) => (
          <div key={group.area} className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.area}
              <span className="ml-1.5 font-normal normal-case tracking-normal">
                ({group.files.length})
              </span>
            </p>
            <ul className="space-y-0.5">
              {group.files.map((file, idx) => {
                const meta = fileStatusMeta(file.status);
                const showCounts =
                  typeof file.additions === "number" &&
                  typeof file.deletions === "number" &&
                  (file.additions > 0 || file.deletions > 0);
                return (
                  <li
                    key={`${file.path}-${idx}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", meta.dot)}
                        title={meta.label}
                      />
                      <span
                        className="truncate font-mono text-[11px] text-foreground/80"
                        title={file.path}
                      >
                        {shortFilePath(file.path)}
                      </span>
                    </span>
                    {showCounts && (
                      <span className="shrink-0 font-mono text-[10px]">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{file.additions}
                        </span>{" "}
                        <span className="text-rose-600 dark:text-rose-400">
                          −{file.deletions}
                        </span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {hiddenCount > 0 && (
          <p className="text-[11px] italic text-muted-foreground/70">
            +{hiddenCount} more {hiddenCount === 1 ? "file" : "files"} not shown
          </p>
        )}
      </div>
    </details>
  );
}
