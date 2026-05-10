import { Suspense } from "react";
import { ScrollText } from "lucide-react";
import { getAuditEvents } from "@/lib/queries/audit";
import { requirePageAccess } from "@/lib/dal";
import { AuditActivityTable } from "./audit-activity-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Audit Log" };

const EVENT_TYPES = [
  { label: "Admin Login", value: "admin_login" },
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
  { label: "Country Restriction Updated", value: "country_restriction_updated" },
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

  const result = await getAuditEvents({
    page,
    perPage,
    search: params.search,
    eventType: params.eventType,
  });

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <ScrollText className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Audit Log</h1>
            <p className="text-sm text-muted-foreground">
              Every admin action logged — searchable by admin, user, IP, or
              event type.
            </p>
          </div>
        </div>
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
          value={formatNumber(EVENT_TYPES.length)}
          icon={ScrollText}
          accent="cyan"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ScrollText} title="Event Stream" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by admin username, user ID, or IP..."
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
