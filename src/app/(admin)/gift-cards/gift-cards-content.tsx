"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { CancelGiftCardDialog } from "./cancel-dialog";
import type { GiftCardListItem } from "@/lib/queries/gift-cards";

const STATUS_STYLES: Record<string, string> = {
  available: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  redeemed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  cancelled: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  expired: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export function GiftCardsContent({ data }: { data: GiftCardListItem[] }) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border">
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
