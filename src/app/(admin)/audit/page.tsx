import { Suspense } from "react";
import { getAuditEvents } from "@/lib/queries/audit";
import { requirePageAccess } from "@/lib/dal";
import { AuditActivityTable } from "./audit-activity-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";

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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Audit Log</h1>
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
    </div>
  );
}
