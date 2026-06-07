"use client";

import { useEffect, useState } from "react";
import { Loader2, Ticket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { getUserVouchers, type UserVoucherRow } from "./actions";

const ORIGIN_LABELS: Record<string, string> = {
  exchange_excess_to_voucher: "Exchange excess",
  battle_excess_to_voucher: "Battle excess",
  pack_borrow_to_voucher: "Pack borrow",
  creator_fill_conversion: "Creator fill",
  creator_multiplier_payout: "Creator multiplier",
  upgrader_excess_to_voucher: "Upgrader excess",
};

function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin.replace(/_/g, " ");
}

/**
 * Unclaimed vouchers a user is holding — rendered in the Inventory tab next
 * to their cards so "current holdings" reflects ALL held value (a voucher is
 * held value just like a card). Loads on mount via the `getUserVouchers`
 * server action; hidden entirely when the user has none.
 */
export function UserVouchersPanel({ userId }: { userId: string }) {
  const [vouchers, setVouchers] = useState<UserVoucherRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getUserVouchers(userId)
      .then((rows) => {
        if (!cancelled) setVouchers(rows);
      })
      .catch(() => {
        if (!cancelled) setVouchers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Hide the section entirely when there's nothing to show (and we're done
  // loading) — keeps the Inventory tab clean for the common no-voucher case.
  if (!loading && (!vouchers || vouchers.length === 0)) return null;

  const total = (vouchers ?? []).reduce((a, v) => a + v.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Ticket className="size-4" />
          Vouchers
          {vouchers && vouchers.length > 0 && (
            <span className="text-muted-foreground">
              — {vouchers.length} ·{" "}
              <span className="tabular-nums">{formatCurrency(total)}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !vouchers || vouchers.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title="No vouchers"
            description="This user has no unclaimed vouchers."
            compact
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {vouchers.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {originLabel(v.origin)}
                    </Badge>
                  </div>
                  {v.description ? (
                    <p
                      className="mt-0.5 truncate text-xs text-muted-foreground"
                      title={v.description}
                    >
                      {v.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {formatRelative(v.createdAt)}
                  </p>
                </div>
                <span className="shrink-0 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(v.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
