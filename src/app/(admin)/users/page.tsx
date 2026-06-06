import { Suspense } from "react";
import Link from "next/link";
import { Users, Ban, Archive, UserPlus, AlertTriangle } from "lucide-react";
import { getUsers, getUsersListStats } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { parseUsersSearchParams } from "./_lib/search-params";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { adminDb } from "@/lib/admin-db";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { ExportUsersButton } from "./export-dialog";
import { ExportAllUsersButton } from "./export-all-users-button";
import { canExportAllUsers } from "@/lib/users-export/motha-gate";
import { SortByNetHoldingsButton } from "./sort-net-holdings-button";
import { SortByUserNetWorthButton } from "./sort-user-net-worth-button";
import {
  SortByPnlLosersButton,
  SortByPnlWinnersButton,
} from "./sort-pnl-buttons";

export const metadata = { title: "Users" };

/**
 * Wall-clock bound for the user-list query. The list's PnL sort (top
 * losers/winners) is the heaviest query on the page — a slow main-DB
 * read used to hang the segment until the platform killed the whole
 * request. Bounding the wait lets a pathological read degrade to the
 * empty-list fallback + an inline notice instead of blocking the page.
 * Generous enough that a healthy prod-sized query finishes well inside
 * it; the underlying statement keeps running on its own connection and
 * warms the next cache fill (see safe-query.ts TIMEOUT note).
 */
const USERS_LIST_TIMEOUT_MS = 45_000;
/** Search uses fast indexed paths — no wall-clock cap (completes in ms). */
const USERS_LIST_SEARCH_TIMEOUT_MS = undefined;

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
  const { page, perPage } = params;

  // The "Deleted users" header button is gated by the same
  // __can_delete_user capability as the delete action itself —
  // admins always pass, non-admins only see the link when they're
  // allowed to delete. Real admins always see it; non-admins need
  // both __can_delete_user AND the /users/deleted page key.
  let canSeeDeletedUsers = session.role === "admin";
  if (!canSeeDeletedUsers) {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    const pages = perms?.allowed_pages ?? [];
    canSeeDeletedUsers =
      pages.includes("/users/deleted") &&
      hasCapability(pages, "__can_delete_user");
  }

  // The "Export all" button (raw 3-column dump of EVERY user) is
  // restricted to the single `motha` admin — derived server-side here
  // so the island only renders for motha. This is defense-in-depth
  // only: the exportAllUsersCsv action re-verifies motha independently
  // and is the real gate. Distinct from the capability-gated filtered
  // ExportUsersButton dialog, which any admin can use.
  const canExportAll = await canExportAllUsers(session.userId);

  // `getDistinctUserCountries()` used to be eager-fetched here for the
  // Export dialog's country filter. It scanned every user row to
  // collect distinct country codes — wasted work on the 95 % of page
  // loads that never open the dialog. Moved to a server action that
  // the dialog itself calls on first open (see ExportUsersButton).
  //
  // KPI stats run in PARALLEL with the table query. The two are
  // semantically independent: the table reads the filtered, paginated
  // slice; the KPI strip reads global aggregates that must stay
  // stable across page navigation + search refinements. Caching is
  // handled inside getUsersListStats (60s unstable_cache) so spamming
  // the search box doesn't fan into the DB on every keystroke.
  //
  // Both queries are wrapped in safeQuery so neither a slow/failed
  // global aggregate NOR a slow/failed list query can take the page
  // down. The list query is the page's primary deliverable, but the
  // PnL sort it can run (top losers/winners) is the heaviest query on
  // the page — an upstream main-DB timeout on it used to throw and the
  // segment-level error.tsx replaced the WHOLE view. Wrapping it (with a
  // wall-clock timeout) degrades a failure to an empty, recoverable
  // list + an inline notice instead: the hero, KPI strip, toolbar and
  // pagination all still render so the admin can clear filters / retry
  // without losing the page. On the happy path the result is identical.
  const EMPTY_LIST: Awaited<ReturnType<typeof getUsers>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };
  const [listResult, statsResult] = await Promise.all([
    safeQuery(
      () =>
        getUsers({
          page,
          perPage,
          search: params.search,
          role: params.role,
          status: params.status,
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          // URL `?match=contains` → slower interior-substring search;
          // anything else (the default) → fast index-backed prefix match.
          searchMode: params.match === "contains" ? "substring" : "prefix",
        }),
      EMPTY_LIST,
      "users.list",
      params.search?.trim()
        ? USERS_LIST_SEARCH_TIMEOUT_MS
        : USERS_LIST_TIMEOUT_MS,
    ),
    safeQuery(() => getUsersListStats(), null, "users.listStats"),
  ]);
  const result = listResult.data;
  const listFailed = listResult.error !== null;
  const stats = statsResult.data;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          title="Users"
          subtitle="Browse, search, and filter every user on the platform."
          action={
            canSeeDeletedUsers ? (
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/users/deleted" />}
              >
                <Archive className="mr-2 size-4" />
                Deleted users
              </Button>
            ) : undefined
          }
        />
      </PageHero>

      {/* KPI strip — GLOBAL aggregates (Total Users, Banned, Signups 24h)
          that read off `stats`, NOT off the paginated `result.data` slice.
          That's deliberate: admins need a stable read-out of the user
          base while they paginate or refine the table. Per-page sums
          (Net Holdings / Deposited) were removed — they shifted on every
          page click and were easy to misread as platform totals.
          Signups (24h) replaces them so the strip surfaces a real
          velocity metric instead.
          When the stats query failed (safeQuery returned null), the
          entire strip degrades to a single TileErrorFallback row instead
          of crashing the page. The table below is unaffected. */}
      {stats ? (
        <div className="grid grid-cols-3 gap-3">
          <KpiTile
            label="Total Users"
            value={formatNumber(stats.totalUsers)}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Banned"
            value={formatNumber(stats.totalBanned)}
            icon={Ban}
            accent="rose"
          />
          <KpiTile
            label="Signups (24h)"
            value={formatNumber(stats.signups24h)}
            icon={UserPlus}
            accent="emerald"
          />
        </div>
      ) : (
        <TileErrorFallback
          label="User stats"
          hint="The global counts query timed out. The user list below is unaffected — refresh to retry."
        />
      )}

      <div className="space-y-3">
        <SectionHeading icon={Users} title="All Users" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by username, email, user ID, or Discord ID..."
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
              ]}
            >
              <SortByPnlLosersButton />
              <SortByPnlWinnersButton />
              <SortByNetHoldingsButton />
              <SortByUserNetWorthButton />
              <ExportUsersButton />
              {canExportAll && <ExportAllUsersButton />}
            </DataTableToolbar>
          </Suspense>
          {/* Recoverable empty state — the list query degraded (timeout
              or error) and safeQuery returned EMPTY_LIST. The toolbar
              above + pagination below still render, so the admin can
              clear filters or refresh without a full page crash. Never
              echoes the raw error string (see safe-query.ts SECURITY
              note) — a generic, actionable notice only. */}
          {listFailed && !params.search?.trim() && (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
            >
              <AlertTriangle
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-amber-500"
              />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Couldn&apos;t load the user list — the query timed out or
                failed. Try{" "}
                <span className="font-medium">clearing your filters</span>{" "}
                or refreshing the page. If it keeps failing, a narrower
                search (exact username, email, or user ID) loads faster.
              </p>
            </div>
          )}
          <UsersDataTable data={result.data} />
          <FadeIn speed="fast">
            <DataTablePagination
              page={result.page}
              totalPages={result.totalPages}
              total={result.total}
              perPage={result.perPage}
              degraded={listFailed}
            />
          </FadeIn>
        </FadeIn>
      </div>
    </div>
  );
}
