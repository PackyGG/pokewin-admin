import { Suspense } from "react";
import { ScrollText } from "lucide-react";
import { getAuditEvents, getDistinctEventTypeCount } from "@/lib/queries/audit";
import { requirePageAccess } from "@/lib/dal";
import { AuditActivityTable } from "./audit-activity-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { ToolbarSkeleton } from "@/components/loading-skeletons";
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

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/audit");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const [result, distinctEventTypes] = await Promise.all([
    getAuditEvents({
      page,
      perPage,
      search: params.search,
      eventType: params.eventType,
    }),
    getDistinctEventTypeCount(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ScrollText}
          title="Audit Log"
          subtitle="Every admin action logged — searchable by admin, user, IP, or event type."
        />
      </PageHero>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
        <KpiTile
          label="Event Types"
          value={formatNumber(distinctEventTypes)}
          icon={ScrollText}
          accent="cyan"
        />
      </div>

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
          <AuditActivityTable data={result.data} />
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        </FadeIn>
      </div>
    </div>
  );
}
