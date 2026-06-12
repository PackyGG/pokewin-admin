import { Suspense } from "react";
import { AlertTriangle, ScrollText } from "lucide-react";
import { getAuditEvents, getDistinctEventTypeCount } from "@/lib/queries/audit";
import { requirePageAccess } from "@/lib/dal";
import {
  safeQuery,
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
  type SafeQueryResult,
} from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { AuditActivityTable } from "./audit-activity-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  KpiStripSkeleton,
  PaginationSkeleton,
  TableSkeleton,
  ToolbarSkeleton,
} from "@/components/loading-skeletons";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Audit Log" };

// Event-type filter options. Reconciled with the sibling per-admin audit
// table (src/app/(admin)/admin-users/[id]/audit-events-table.tsx
// EVENT_TYPE_LABELS) so the two audit surfaces agree on the known taxonomy.
// NOTE: createAdminAuditEvent accepts an arbitrary event_type string, so this
// list is a curated whitelist of the common types — not an exhaustive mirror
// of the DB. The "Event Types" KPI is therefore computed from a real distinct
// DB count (see below), not from this array's length.
const EVENT_TYPES = [
  { label: "Admin Login", value: "admin_login" },
  { label: "Admin User Created", value: "admin_user_created" },
  { label: "Admin User Activated", value: "admin_user_activated" },
  { label: "Admin User Deactivated", value: "admin_user_deactivated" },
  { label: "Admin User Deleted", value: "admin_user_deleted" },
  { label: "Admin Role Changed", value: "admin_role_changed" },
  { label: "Admin 2FA Reset", value: "admin_2fa_reset" },
  { label: "Admin Sessions Expired", value: "admin_sessions_force_expired" },
  { label: "Admin Role Created", value: "admin_role_created" },
  { label: "Admin Role Updated", value: "admin_role_updated" },
  { label: "Admin Role Deleted", value: "admin_role_deleted" },
  { label: "Role Permissions Updated", value: "role_permissions_updated" },
  { label: "User Permissions Updated", value: "user_permissions_updated" },
  { label: "Account Banned", value: "account_banned" },
  { label: "Account Unbanned", value: "account_unbanned" },
  { label: "Account Locked", value: "account_locked" },
  { label: "Account Unlocked", value: "account_unlocked" },
  { label: "Balance Adjustment", value: "balance_adjustment" },
  { label: "Role Changed", value: "role_changed" },
  { label: "Pack Activated", value: "pack_activated" },
  { label: "Pack Deactivated", value: "pack_deactivated" },
  { label: "Pack Update Approved", value: "pack_update_approved" },
  { label: "Pack Update Rejected", value: "pack_update_rejected" },
  { label: "Card Update Approved", value: "card_update_approved" },
  { label: "Card Update Rejected", value: "card_update_rejected" },
  { label: "Chat Message Deleted", value: "chat_message_deleted" },
  { label: "Chat Message Pinned", value: "chat_message_pinned" },
  { label: "Chat Message Unpinned", value: "chat_message_unpinned" },
  { label: "Chat Muted", value: "chat_muted" },
  { label: "Chat Unmuted", value: "chat_unmuted" },
  { label: "Withdrawal Processed", value: "withdrawal_processed" },
  { label: "Withdrawal Shipped", value: "withdrawal_shipped" },
  { label: "Withdrawal Completed", value: "withdrawal_completed" },
  { label: "Withdrawal Cancelled", value: "withdrawal_cancelled" },
  { label: "Withdrawal Failed", value: "withdrawal_failed" },
  { label: "Promo Code Created", value: "promo_code_created" },
  { label: "Promo Code Deleted", value: "promo_code_deleted" },
  { label: "Affiliate Payout", value: "affiliate_payout_processed" },
  { label: "Rakeback Config Updated", value: "rakeback_config_updated" },
  { label: "Race Prize Updated", value: "race_prize_tier_updated" },
  { label: "Race Started", value: "race_period_started" },
  { label: "Race Ended", value: "race_period_ended" },
  { label: "Race Auto-renew Toggled", value: "race_period_auto_renew_toggled" },
  { label: "Race Claims Frozen", value: "race_period_claims_frozen" },
  { label: "Race Claims Opened", value: "race_period_claims_opened" },
  { label: "Race User Claim Frozen", value: "race_claim_frozen" },
  { label: "Race User Claim Opened", value: "race_claim_unfrozen" },
  { label: "Country Restriction Updated", value: "country_restriction_updated" },
  { label: "Admin Note Added", value: "admin_note_created" },
  { label: "Admin Note Deleted", value: "admin_note_deleted" },
  { label: "Creator Deal Updated", value: "creator_deal_updated" },
  { label: "Creator Webhook Created", value: "creator_webhook_created" },
  { label: "Creator Webhook Updated", value: "creator_webhook_updated" },
  { label: "Creator Webhook Deleted", value: "creator_webhook_deleted" },
];

type AuditListResult = Awaited<ReturnType<typeof getAuditEvents>>;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/audit");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Empty shape getAuditEvents would return for zero rows — the safeQuery
  // fallback, so the table + pagination still paint (degraded) when the
  // query fails or times out.
  const EMPTY_LIST: AuditListResult = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // Start both reads NOW (unawaited) and share the promises across the two
  // Suspense legs below: the KPI strip and the table consume the SAME
  // getAuditEvents round-trip (no duplicate query), while the hero, section
  // heading and toolbar flush immediately instead of blocking the whole
  // route on the reads (house lazy-leg pattern, see /users). safeQuery
  // never rejects, so the promises are safe to hold unawaited.
  const eventsPromise = safeQuery(
    () =>
      getAuditEvents({
        page,
        perPage,
        search: params.search,
        eventType: params.eventType,
      }),
    EMPTY_LIST,
    "audit.list",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const typeCountPromise = safeQueryOrNull(
    () => getDistinctEventTypeCount(),
    "audit.typeCount",
    REWARD_QUERY_TIMEOUT_MS,
  );

  // Key the streamed legs on every query input so an in-segment navigation
  // (page click, filter change, search commit) re-shows the skeletons while
  // the new slice streams instead of pinning stale rows.
  const sectionKey = [
    page,
    perPage,
    params.search ?? "",
    params.eventType ?? "",
  ].join("|");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ScrollText}
          title="Audit Log"
          subtitle="Every admin action logged — searchable by admin, user, IP, or event type."
        />
      </PageHero>

      <Suspense
        key={`kpi-${sectionKey}`}
        fallback={<KpiStripSkeleton count={3} />}
      >
        <AuditKpiStrip
          eventsPromise={eventsPromise}
          typeCountPromise={typeCountPromise}
        />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={ScrollText} title="Event Stream" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<ToolbarSkeleton filters={1} />}>
            <DataTableToolbar
              searchPlaceholder="Search by admin or user username, user ID, or IP..."
              filters={[
                {
                  name: "Event Type",
                  paramKey: "eventType",
                  options: EVENT_TYPES,
                },
              ]}
            />
          </Suspense>
          <Suspense
            key={sectionKey}
            fallback={
              <>
                <TableSkeleton rows={Math.min(perPage, 15)} columns={6} />
                <PaginationSkeleton />
              </>
            }
          >
            <AuditTableSection eventsPromise={eventsPromise} />
          </Suspense>
        </FadeIn>
      </div>
    </div>
  );
}

/**
 * KPI leg — consumes the shared list read + the distinct-type count, each
 * already wrapped in safeQuery. A failed read degrades only its own tile(s)
 * to TileErrorFallback while the rest of the strip renders real data.
 */
async function AuditKpiStrip({
  eventsPromise,
  typeCountPromise,
}: {
  eventsPromise: Promise<SafeQueryResult<AuditListResult>>;
  typeCountPromise: Promise<{ data: number | null; error: string | null }>;
}) {
  const [eventsResult, typeCountResult] = await Promise.all([
    eventsPromise,
    typeCountPromise,
  ]);
  const result = eventsResult.data;
  const eventsFailed = eventsResult.error !== null;
  const distinctEventTypes = typeCountResult.data;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {eventsFailed ? (
        <>
          <TileErrorFallback label="Total Events" />
          <TileErrorFallback label="On Page" />
        </>
      ) : (
        <>
          <KpiTile
            label="Total Events"
            value={formatNumber(result.total)}
            icon={ScrollText}
            accent="blue"
          />
          <KpiTile
            label="On Page"
            value={formatNumber(result.data.length)}
            icon={ScrollText}
            accent="purple"
          />
        </>
      )}
      {distinctEventTypes === null ? (
        <TileErrorFallback label="Event Types" />
      ) : (
        <KpiTile
          label="Event Types"
          value={formatNumber(distinctEventTypes)}
          icon={ScrollText}
          accent="cyan"
        />
      )}
    </div>
  );
}

/**
 * Table leg — consumes the shared list read; a failed/hung query degrades
 * to an empty table + a VISIBLE amber band while the pagination still
 * paints (mirrors UsersTableSection on /users). Never echoes the raw error
 * string (see safe-query.ts SECURITY note).
 */
async function AuditTableSection({
  eventsPromise,
}: {
  eventsPromise: Promise<SafeQueryResult<AuditListResult>>;
}) {
  const listResult = await eventsPromise;
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
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
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load the audit log — the query timed out or failed.
            This is a{" "}
            <span className="font-medium">query error, not an empty log</span>
            . Refresh to retry, or narrow the search / event-type filter.
          </p>
        </div>
      )}
      <AuditActivityTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
        degraded={listFailed}
      />
    </>
  );
}
