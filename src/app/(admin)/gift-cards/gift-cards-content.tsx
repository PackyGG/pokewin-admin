"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatRelative } from "@/lib/utils/format";
import { CancelGiftCardDialog } from "./cancel-dialog";
import type { GiftCardListItem } from "@/lib/queries/gift-cards";

const STATUS_STYLES: Record<string, string> = {
  available: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  redeemed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  expired: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

function GiftCardMobileCard({ c }: { c: GiftCardListItem }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <div className="flex size-9 items-center justify-center rounded-md bg-emerald-500/10 shrink-0">
          <Gift className="size-4 text-emerald-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm">{c.code ?? c.id.slice(0, 8) + "…"}</span>
            <Badge
              variant="outline"
              className={"h-4 px-1 text-[9px] capitalize " + STATUS_STYLES[c.status]}
            >
              {c.status}
            </Badge>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 text-[10px] text-muted-foreground">
            <div>
              <span className="text-[9px] uppercase tracking-wide">Created by</span>
              <div>
                {c.createdByAdminId ? (
                  <Link
                    href={`/admin-users/${c.createdByAdminId}`}
                    className="hover:underline truncate"
                  >
                    {c.createdByUsername}
                  </Link>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div>
              <span className="text-[9px] uppercase tracking-wide">Redeemed by</span>
              <div className="truncate">{c.redeemedByUsername ?? "—"}</div>
            </div>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {c.expiresAt ? (
              <>Expires {formatDate(c.expiresAt)} · </>
            ) : (
              <>Never expires · </>
            )}
            Created {formatRelative(c.createdAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* House-POV: gift-card value is house-paid credit → liability → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(c.value)}
          </div>
          {c.status === "available" && (
            <div className="mt-1">
              <CancelGiftCardDialog giftCardId={c.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GiftCardsContent({ data }: { data: GiftCardListItem[] }) {
  return (
    <div className="space-y-4">
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No gift cards found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((c) => (
              <GiftCardMobileCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created By</TableHead>
              <TableHead>Redeemed By</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">{c.id.slice(0, 8)}...</TableCell>
                <TableCell className="font-mono text-xs">{c.code ?? "-"}</TableCell>
                <TableCell>{formatCurrency(c.value)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_STYLES[c.status]}>
                    {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {c.createdByAdminId ? (
                    <Link href={`/admin-users/${c.createdByAdminId}`} className="hover:underline">
                      {c.createdByUsername}
                    </Link>
                  ) : "-"}
                </TableCell>
                <TableCell>{c.redeemedByUsername ?? "-"}</TableCell>
                <TableCell>{c.expiresAt ? formatDate(c.expiresAt) : "Never"}</TableCell>
                <TableCell>{formatDate(c.createdAt)}</TableCell>
                <TableCell>
                  {c.status === "available" && (
                    <CancelGiftCardDialog giftCardId={c.id} />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">No gift cards found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
