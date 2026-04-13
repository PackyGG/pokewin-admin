"use client";

import { useState, useTransition } from "react";
import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PromoCodeListItem } from "@/lib/queries/promo-codes";
import { getRedemptions } from "./actions";

type Redemption = {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  ipAddress: string;
  redeemedAt: string;
};

function RedemptionsCell({
  promoCodeId,
  count,
  maxUses,
}: {
  promoCodeId: string;
  count: number;
  maxUses: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Redemption[] | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleOpen() {
    setOpen(true);
    if (!data) {
      startTransition(async () => {
        const result = await getRedemptions(promoCodeId);
        setData(result);
      });
    }
  }

  return (
    <>
      <button
        onClick={handleOpen}
        className="font-medium tabular-nums hover:underline"
      >
        {count} / {maxUses}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Redemptions ({count})
            </DialogTitle>
          </DialogHeader>
          {isPending && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          )}
          {data && data.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No redemptions yet.
            </p>
          )}
          {data && data.length > 0 && (
            <div className="max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link
                          href={`/users/${r.userId}`}
                          className="flex items-center gap-2 hover:underline"
                          onClick={() => setOpen(false)}
                        >
                          <div className="size-6 shrink-0 overflow-hidden rounded-full bg-muted">
                            {r.image &&
                            (r.image.startsWith("https://") ||
                              r.image.startsWith("http://")) ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={r.image}
                                alt=""
                                className="size-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="flex size-full items-center justify-center text-[10px] font-bold text-muted-foreground">
                                {(r.username ?? r.email ?? "?")[0].toUpperCase()}
                              </div>
                            )}
                          </div>
                          <span className="text-sm">
                            {r.username ?? r.email ?? r.userId.slice(0, 8)}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.ipAddress}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(r.redeemedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export const columns: ColumnDef<PromoCodeListItem>[] = [
  {
    accessorKey: "code",
    header: "Code",
    cell: ({ row }) => (
      <Link
        href={`/promo-codes/${row.original.id}`}
        className="font-mono text-xs hover:underline"
      >
        {row.original.code ?? row.original.codeHash.slice(0, 16) + "..."}
      </Link>
    ),
  },
  {
    accessorKey: "value",
    header: "Value",
    cell: ({ row }) => formatCurrency(row.original.value),
  },
  {
    accessorKey: "minimumLevel",
    header: "Min Level",
  },
  {
    accessorKey: "maxUses",
    header: "Max Uses",
  },
  {
    accessorKey: "redemptionCount",
    header: "Redemptions",
    cell: ({ row }) => (
      <RedemptionsCell
        promoCodeId={row.original.id}
        count={row.original.redemptionCount}
        maxUses={row.original.maxUses}
      />
    ),
  },
  {
    accessorKey: "expiresAt",
    header: "Expires",
    cell: ({ row }) => {
      if (!row.original.expiresAt) return "Never";
      const expired = new Date(row.original.expiresAt) < new Date();
      return (
        <span className={expired ? "text-red-400" : ""}>
          {formatDate(row.original.expiresAt)}
        </span>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => formatDate(row.original.createdAt),
  },
];
