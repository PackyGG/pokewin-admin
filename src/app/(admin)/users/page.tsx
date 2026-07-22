import { Suspense } from "react";
import Link from "next/link";
import { Users, Ban, UserPlus, AlertTriangle, X, Ticket, ArrowRight } from "lucide-react";
import { getUsers, getUsersListStats, getMatchingAffiliateCodes } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, safeQueryOrNull } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  parseUsersSearchParams,
  type UsersSearchParams,
} from "./_lib/search-params";
import { getUsersPageGates } from "./_lib/admin-gates";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UsersDataTable } from "./data-table";
import { CodeSearchToggle } from "./code-search-toggle";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { SortByUserNetWorthButton } from "./sort-user-net-worth-button";
import {
  SortByPnlLosersButton,
  SortByPnlWinnersButton,
} from "./sort-pnl-buttons";
import {
  KpiStripSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

export const metadata = { title: "Users" };

/**
 * Wall-clock bound for the non-search user-list query. The prod main DB
 * already enforces `statement_timeout = 30s` (src/lib/db.ts), which kills
 * a runaway statement long before a longer wall clock would fire — so
 * this bound exists to catch what a statement timeout can't see: pool
 * exhaustion and network hangs. 20s is far above every measured prod
 * query on this page (0.2–126 ms wall, 2026-06-11) while still degrading
 * a hung connection to the visible failure band instead of pinning the
 * segment. NOTE the underlying statement is not cancelled by this race —
 * only our wait ends (see safe-query.ts TIMEOUT note).
 */
const USERS_LIST_TIMEOUT_MS = 20_000;
/**
 * Search queries get a tighter bound. The previous `undefined` (no cap)
 * was justified as "search uses fast indexed paths" — which is FALSE on
 * prod today: none of the recommended indexes
 * (prisma/recommended-indexes.sql) are applied, so a free-form search is
 * a bounded seq scan. 15s is far above the measured worst case and means
 * a hung search degrades to the visible failure band instead of hanging
 * the leg forever.
 */
const USERS_LIST_SEARCH_TIMEOUT_MS = 15_000;
/** KPI strip — one COUNT(*) FILTER aggregate over `user`; bound likewise. */
const USERS_STATS_TIMEOUT_MS = 15_000;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Self-heal: ensure every support user has /users in their
  // allowed_pages before the gate runs. Without this, an admin who
  // saves /settings/roles → Support with /users accidentally unchecked
  // can silently lock the whole support team out of the page. Runs
  // once per server process; see src/lib/support-baseline.ts.
  await ensureSupportBaseline();
  const session = await requirePageAccess("/users");
  // Validate + clamp the raw searchParams through Zod BEFORE any value
  // reaches the query. A malformed page/perPage (e.g. ?page=-5 →
  // negative OFFSET, ?page=1e10 → 10-billion-row scan) or an unknown
  // filter/sort key used to be handed straight to getUsers and could
  // crash the whole list at the SQL layer. parseUsersSearchParams snaps
  // every bad value back to a safe default (dropping only the offending
  // param, keeping the rest) so the query only ever sees values it can
  // execute. See ./_lib/search-params.ts.
  const params = parseUsersSearchParams(await searchParams);

  // ONE consolidated, fail-closed adminDb read for every render-cosmetic
  // gate flag (Deleted-users button, excluded-users search override).
  // Replaces three sequential unguarded lookups
  // that could crash the whole page to error.tsx on an adminDb hiccup.
  // See ./_lib/admin-gates.ts — every action re-verifies server-side.
  const gates = await getUsersPageGates(session);

  // Key the table leg on every param that changes its result so a param
  // change (search keystroke commit, sort shortcut, page click) unmounts
  // the old leg and shows the skeleton while the new slice streams —
  // honest progress instead of frozen stale rows, and a previously hung
  // query can never pin old content (house lazy-leg pattern).
  const tableKey = [
    params.page,
    params.perPage,
    params.search,
    params.match,
    params.role,
    params.status,
    params.sortBy,
    params.sortOrder,
    params.affiliateCode,
    params.affiliateOwnerId,
    params.codeSearch,
  ].join("|");

  // "Clear" href for the affiliateCode / affiliateOwnerId filter chip below
  // — drops BOTH referral-filter params from the current URL (only one is
  // ever active at a time, see buildUserListWhereClause), keeping every
  // other param (search, role, status, sort) intact. Built from the
  // validated params object (not the raw searchParams) so a fuzzed/invalid
  // value never leaks back into the URL.
  const clearAffiliateFilterParams = new URLSearchParams();
  if (params.search) clearAffiliateFilterParams.set("search", params.search);
  if (params.match !== "prefix") clearAffiliateFilterParams.set("match", params.match);
  if (params.role) clearAffiliateFilterParams.set("role", params.role);
  if (params.status) clearAffiliateFilterParams.set("status", params.status);
  if (params.sortBy) clearAffiliateFilterParams.set("sortBy", params.sortBy);
  if (params.sortOrder) clearAffiliateFilterParams.set("sortOrder", params.sortOrder);
  const clearAffiliateFilterHref = clearAffiliateFilterParams.size
    ? `/users?${clearAffiliateFilterParams.toString()}`
    : "/users";

  // MAIN-DB work streams below: the shell (hero + headings + toolbar)
  // paints immediately after the cheap auth/gate reads above; the KPI
  // strip and the table each own an independent Suspense leg, so one
  // slow/failed leg can never blank the rest of the page and the segment
  // error.tsx is truly last-resort.
  return (
    <div className="space-y-6">
      <PageHero>
        {/* No hero action — the "Deleted users" button was removed (owner,
            2026-07-22). /users/deleted still exists and is reachable by URL;
            it gates itself with requirePageAccess("/users/deleted"), so
            dropping the link changes discoverability, not access. */}
        <PageHeroIdentity
          icon={Users}
          title="Users"
          subtitle="Browse, search, and filter every user on the platform."
        />
      </PageHero>

      {/* KPI strip — GLOBAL aggregates (Total Users, Banned, Signups 24h),
          NOT the paginated slice, so the read-out stays stable while
          admins paginate/refine. Own Suspense leg (unkeyed — global stats
          don't depend on table params) + safeQuery inside, so a slow or
          failed aggregate degrades to TileErrorFallback without touching
          the table below. */}
      <Suspense fallback={<KpiStripSkeleton count={3} />}>
        <UsersKpiStrip />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={Users} title="All Users" />
        <FadeIn className="space-y-4">
          {/* Minimal active-filter indicator — /users has no per-filter
              chip system (DataTableToolbar only offers a generic "Clear"
              that resets every param at once), so this stays a plain text
              line rather than introducing a new chip subsystem for one
              filter. Only rendered when a "View referrals" / "View all
              referrals" link (users/[id] OwnCodeCard / OwnedCodeRow) sent us
              here with `?affiliateCode=` or `?affiliateOwnerId=`. The two
              are alternatives (see buildUserListWhereClause), so at most one
              of these renders. */}
          {params.affiliateOwnerId ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Showing all referrals for this affiliate
              <Link
                href={clearAffiliateFilterHref}
                className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <X className="size-3" />
                Clear
              </Link>
            </p>
          ) : (
            params.affiliateCode && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Showing referrals for code{" "}
                <span className="font-mono font-medium text-foreground">
                  {params.affiliateCode}
                </span>
                <Link
                  href={clearAffiliateFilterHref}
                  className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  <X className="size-3" />
                  Clear
                </Link>
              </p>
            )
          )}
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder={
                params.codeSearch
                  ? "Search affiliate/creator codes (type a code, find its owner)..."
                  : "Search by username, email, user ID, Discord ID, or affiliate code..."
              }
              afterSearch={<CodeSearchToggle />}
              filters={[
                {
                  name: "Role",
                  paramKey: "role",
                  options: [
                    { label: "Admin", value: "admin" },
                    { label: "Support", value: "support" },
                    { label: "Creator", value: "creator" },
                    { label: "User", value: "user" },
                  ],
                },
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Active", value: "active" },
                    { label: "Banned", value: "banned" },
                    { label: "Locked", value: "locked" },
                  ],
                },
                // ── Audit filters (bonus-farming triage) ──────────────
                {
                  name: "Deposited",
                  paramKey: "deposited",
                  options: [
                    { label: "Has deposited", value: "yes" },
                    { label: "Never deposited", value: "no" },
                  ],
                },
                {
                  name: "Signup",
                  paramKey: "provider",
                  options: [
                    { label: "Discord", value: "discord" },
                    { label: "Google", value: "google" },
                    { label: "Steam", value: "steam" },
                    { label: "Email + password", value: "credential" },
                  ],
                },
                {
                  name: "Signup IP",
                  paramKey: "sharedIp",
                  options: [
                    { label: "Shared with others", value: "yes" },
                    { label: "Unique to user", value: "no" },
                  ],
                },
                {
                  name: "Device",
                  paramKey: "sharedDevice",
                  options: [{ label: "Shared with others", value: "yes" }],
                },
                {
                  name: "Free value only",
                  paramKey: "freeOnly",
                  options: [
                    { label: "Rain, no deposit", value: "rain" },
                    { label: "Reward, no deposit", value: "reward" },
                  ],
                },
              ]}
            >
              <SortByPnlLosersButton />
              <SortByPnlWinnersButton />
              <SortByUserNetWorthButton />
            </DataTableToolbar>
          </Suspense>
          {/* "Affiliate code only" mode: surface the matched CODES as links to
              their stats page (/creators/codes/<code>) ABOVE the owner rows, so
              a code search can open the code's stats — not only the owner user
              ("option between both", owner 2026-07-12). Own Suspense boundary so
              the code lookup never blocks the user table. */}
          {params.codeSearch && params.search?.trim() ? (
            <Suspense fallback={<Skeleton className="h-20 w-full rounded-xl" />}>
              <MatchingCodesPanel term={params.search.trim()} />
            </Suspense>
          ) : null}
          <Suspense
            key={tableKey}
            fallback={
              <div className="space-y-4">
                {/* Same pieces loading.tsx uses → zero CLS on swap. */}
                <SkeletonTable rows={20} columns={7} rowHeight={52} />
                <PaginationSkeleton />
              </div>
            }
          >
            <UsersTableSection
              params={params}
              includeExcludedInSearch={gates.includeExcludedInSearch}
            />
          </Suspense>
        </FadeIn>
      </div>
    </div>
  );
}

/**
 * "Matching codes" panel — shown above the user table when "Affiliate code
 * only" search is active. Lists each affiliate/creator code matching the typed
 * prefix as a link to the code's stats page (`/creators/codes/<code>`), so a
 * code search can open the CODE'S stats — while the owner user rows below stay
 * reachable ("option between both"). Own Suspense boundary + safeQueryOrNull so
 * a slow/failed lookup degrades to nothing, never blocks the table.
 */
async function MatchingCodesPanel({ term }: { term: string }) {
  const { data: codes } = await safeQueryOrNull(
    () => getMatchingAffiliateCodes(term, 24),
    "users.matchingCodes",
  );
  if (!codes || codes.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Ticket className="size-3.5" />
        Matching codes — open the code’s stats page
      </p>
      <div className="flex flex-wrap gap-2">
        {codes.map((c) => (
          <Link
            key={c.code}
            href={`/creators/codes/${encodeURIComponent(c.code)}`}
            className="group inline-flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/50"
          >
            <span className="font-mono font-semibold">{c.code}</span>
            {c.ownerUsername ? (
              <span className="text-xs text-muted-foreground">· {c.ownerUsername}</span>
            ) : null}
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * KPI leg — global user-base counts behind their own safeQuery + timeout.
 * Failure shape is the existing TileErrorFallback row, never a crash.
 */
async function UsersKpiStrip() {
  const statsResult = await safeQuery(
    () => getUsersListStats(),
    null,
    "users.listStats",
    USERS_STATS_TIMEOUT_MS,
  );
  const stats = statsResult.data;

  if (!stats) {
    return (
      <TileErrorFallback
        label="User stats"
        hint="The global counts query timed out. The user list below is unaffected — refresh to retry."
      />
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      <KpiTile
        label="Total Users"
        value={formatNumber(stats.totalUsers)}
        icon={Users}
        accent="blue"
      />
      {/* Clickable drill-in: the list already supports `?status=banned`
          (users-list.ts adds `u.is_banned = true`), so the tile just links
          into the filter that exists rather than needing its own page.
          `interactive` opts this tile into press feedback — the house rule
          is that KPI tiles stay static unless they're actually clickable. */}
      <Link
        href="/users?status=banned"
        className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Banned users: ${formatNumber(stats.totalBanned)} — view the banned list`}
      >
        <KpiTile
          label="Banned"
          value={formatNumber(stats.totalBanned)}
          icon={Ban}
          accent="rose"
          interactive
        />
      </Link>
      <KpiTile
        label="Signups (24h)"
        value={formatNumber(stats.signups24h)}
        icon={UserPlus}
        accent="emerald"
      />
    </div>
  );
}

/**
 * Table leg — owns the list query, the ALWAYS-VISIBLE failure band, the
 * table, and the pagination. All props are plain serializables (no
 * function props across the RSC boundary).
 */
async function UsersTableSection({
  params,
  includeExcludedInSearch,
}: {
  params: UsersSearchParams;
  includeExcludedInSearch: boolean;
}) {
  const { page, perPage } = params;
  const isSearch = Boolean(params.search?.trim());

  const EMPTY_LIST: Awaited<ReturnType<typeof getUsers>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (with a wall-clock bound) degrades a failed/hung list query
  // to an EMPTY list + a VISIBLE error band — the hero, KPI strip, toolbar
  // and pagination all keep rendering so the admin can clear filters or
  // retry without losing the page. On the happy path the result is
  // identical to calling getUsers directly.
  const listResult = await safeQuery(
    () =>
      getUsers({
        page,
        perPage,
        search: params.search,
        role: params.role,
        status: params.status,
        deposited: params.deposited,
        provider: params.provider,
        sharedIp: params.sharedIp,
        sharedDevice: params.sharedDevice,
        freeOnly: params.freeOnly,
        sortBy: params.sortBy,
        sortOrder: params.sortOrder,
        // URL `?match=contains` → slower interior-substring search;
        // anything else (the default) → left-anchored prefix match.
        searchMode: params.match === "contains" ? "substring" : "prefix",
        // "Affiliate code only" toolbar checkbox — restrict the search to
        // affiliate/creator codes (prefix) and return the code owners.
        codeSearch: params.codeSearch,
        includeExcludedInSearch,
        affiliateCode: params.affiliateCode,
        affiliateOwnerId: params.affiliateOwnerId,
      }),
    EMPTY_LIST,
    "users.list",
    isSearch ? USERS_LIST_SEARCH_TIMEOUT_MS : USERS_LIST_TIMEOUT_MS,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
      {/* Recoverable failure state — renders on EVERY degraded list query,
          search or not. (It was previously suppressed while a search term
          was active, which made a failed search indistinguishable from
          "0 matches" — the silent-failure class this remake kills.) Never
          echoes the raw error string (see safe-query.ts SECURITY note). */}
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          {isSearch ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Search failed — this is a{" "}
              <span className="font-medium">query error, not zero matches</span>
              . Refresh to retry, or narrow the term (exact username, email,
              or user ID).
            </p>
          ) : (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Couldn&apos;t load the user list — the query timed out or
              failed. Try{" "}
              <span className="font-medium">
                clearing your filters and sort shortcuts
              </span>{" "}
              (Top losers / Top winners / Net holdings) or refreshing the
              page. If it keeps failing, a narrower search (exact username,
              email, or user ID) loads faster.
            </p>
          )}
        </div>
      )}
      <UsersDataTable data={result.data} degraded={listFailed} />
      <FadeIn speed="fast">
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
          degraded={listFailed}
        />
      </FadeIn>
    </>
  );
}
