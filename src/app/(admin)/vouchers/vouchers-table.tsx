import Link from "next/link";
import { Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatDateTime, formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import type { VoucherListItem } from "@/lib/queries/vouchers";

function VoucherMobileCard({
  v,
  claimed,
}: {
  v: VoucherListItem;
  claimed: boolean;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Ticket className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/users/${v.userId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {v.username ?? v.userId.slice(0, 8)}
            </Link>
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              {v.originLabel}
            </Badge>
            {claimed && v.isFtd && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
              >
                FTD
              </Badge>
            )}
          </div>
          {v.description && (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {v.description}
            </div>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground">
            <span>
              By{" "}
              {v.createdByAdminId ? (
                <Link
                  href={`/admin-users/${v.createdByAdminId}`}
                  className="hover:underline"
                >
                  {v.createdByUsername}
                </Link>
              ) : (
                "System"
              )}
            </span>
            {claimed && v.claimedAt ? (
              <>
                {" · Claimed "}
                {formatRelative(v.claimedAt)}
              </>
            ) : (
              <>
                {" · "}
                {formatRelative(v.createdAt)}
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* House-POV: voucher value is unspent credit owed to user → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(v.value)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function VouchersTable({
  data,
  claimed,
}: {
  data: VoucherListItem[];
  claimed: boolean;
}) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Ticket}
              title="No vouchers found"
              description={
                claimed
                  ? "Claimed vouchers will appear here once players redeem them."
                  : "Unclaimed vouchers will appear here once they are issued."
              }
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((v) => (
              <VoucherMobileCard key={v.id} v={v} claimed={claimed} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Created By</TableHead>
              <TableHead>Description</TableHead>
              {claimed && <TableHead>FTD</TableHead>}
              {claimed && <TableHead>Claimed At</TableHead>}
              <TableHead>Created At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((v) => (
              <TableRow key={v.id}>
                <TableCell>
                  <Link href={`/users/${v.userId}`} className="hover:underline">
                    {v.username ?? v.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{formatCurrency(v.value)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{v.originLabel}</Badge>
                </TableCell>
                <TableCell>
                  {v.createdByAdminId ? (
                    <Link
                      href={`/admin-users/${v.createdByAdminId}`}
                      className="hover:underline"
                    >
                      {v.createdByUsername}
                    </Link>
                  ) : (
                    "System"
                  )}
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  {v.description ?? "-"}
                </TableCell>
                {claimed && (
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        v.isFtd
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                          : "bg-muted text-muted-foreground border-border"
                      }
                    >
                      {v.isFtd ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                )}
                {claimed && (
                  <TableCell>
                    {v.claimedAt ? formatDateTime(v.claimedAt) : "-"}
                  </TableCell>
                )}
                <TableCell>{formatDate(v.createdAt)}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={claimed ? 8 : 6} className="p-0">
                  <EmptyState
                    icon={Ticket}
                    title="No vouchers found"
                    description={
                      claimed
                        ? "Claimed vouchers will appear here once players redeem them."
                        : "Unclaimed vouchers will appear here once they are issued."
                    }
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
