"use client";

import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { CreditCard } from "lucide-react";
import { useRouter } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { MobileCard } from "@/components/data-table/mobile-card-list";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CardPaymentListItem } from "@/lib/queries/card-payments";
import { formatCurrency, formatRelative } from "@/lib/utils/format";

const STATUS_CLASSES: Record<string, string> = {
  completed:
    "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  checkout_creating:
    "border-slate-500/30 bg-slate-500/15 text-slate-600 dark:text-slate-400",
  checkout_ready:
    "border-cyan-500/30 bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  pending:
    "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  created:
    "border-slate-500/30 bg-slate-500/15 text-slate-600 dark:text-slate-400",
  review:
    "border-orange-500/30 bg-orange-500/15 text-orange-600 dark:text-orange-400",
  failed:
    "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400",
  canceled:
    "border-slate-500/30 bg-slate-500/15 text-slate-600 dark:text-slate-400",
  partially_refunded:
    "border-violet-500/30 bg-violet-500/15 text-violet-600 dark:text-violet-400",
  refunded:
    "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400",
  disputed:
    "border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400",
};

function usd(cents: number | null): string {
  return cents == null ? "—" : formatCurrency(cents / 100);
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={STATUS_CLASSES[status] ?? ""}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

const columns: ColumnDef<CardPaymentListItem>[] = [
  {
    accessorKey: "username",
    header: "User",
    cell: ({ row }) => (
      <div className="min-w-40">
        <Link
          href={`/users/${row.original.userId}`}
          className="font-medium hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {row.original.username ?? row.original.email ?? "Unknown user"}
        </Link>
        <p className="max-w-48 truncate font-mono text-[10px] text-muted-foreground">
          {row.original.userId}
        </p>
      </div>
    ),
  },
  {
    accessorKey: "requestedAmountCents",
    header: "Requested",
    cell: ({ row }) => (
      <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
        {usd(row.original.requestedAmountCents)}
      </span>
    ),
  },
  {
    accessorKey: "actualCustomerTotalCents",
    header: "Customer paid",
    cell: ({ row }) => (
      <span className="tabular-nums">{usd(row.original.actualCustomerTotalCents)}</span>
    ),
  },
  {
    accessorKey: "creditedAmountCents",
    header: "Credited",
    cell: ({ row }) => (
      <span className="tabular-nums">{usd(row.original.creditedAmountCents)}</span>
    ),
  },
  {
    accessorKey: "providerNetAmountCents",
    header: "Provider net",
    cell: ({ row }) => (
      <div className="text-right tabular-nums">
        <p>{usd(row.original.providerNetAmountCents)}</p>
        {row.original.feeAmountCents > 0 && (
          <p className="text-[10px] text-rose-600 dark:text-rose-400">
            {usd(row.original.feeAmountCents)} fees
          </p>
        )}
      </div>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <div className="space-y-1">
        <StatusBadge status={row.original.status} />
        {row.original.providerPaymentStatus && (
          <p className="text-[10px] text-muted-foreground">
            Whop: {row.original.providerPaymentStatus}
          </p>
        )}
      </div>
    ),
  },
  {
    accessorKey: "providerPaymentId",
    header: "Payment ID",
    cell: ({ row }) => (
      <span className="block max-w-44 truncate font-mono text-xs" title={row.original.providerPaymentId ?? undefined}>
        {row.original.providerPaymentId ?? row.original.providerCheckoutId ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatRelative(row.original.createdAt)}
      </span>
    ),
  },
];

function CardPaymentMobileCard({ payment }: { payment: CardPaymentListItem }) {
  return (
    <Link href={`/transactions/card-payments/${payment.id}`} className="block">
      <MobileCard
        leading={
          <div className="grid size-9 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <CreditCard className="size-4" />
          </div>
        }
        primary={payment.username ?? payment.email ?? payment.userId.slice(0, 12)}
        secondary={payment.providerPaymentId ?? payment.providerCheckoutId ?? payment.id}
        trailing={
          <div className="flex flex-col items-end gap-1">
            <span className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
              {usd(payment.requestedAmountCents)}
            </span>
            <StatusBadge status={payment.status} />
          </div>
        }
        footer={formatRelative(payment.createdAt)}
        showChevron
      />
    </Link>
  );
}

export function CardPaymentsTable({ data }: { data: CardPaymentListItem[] }) {
  const router = useRouter();
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  const empty = (
    <EmptyState
      icon={CreditCard}
      title="No card payments found"
      description="No mirrored Whop payment intents match the current filters."
      compact
    />
  );

  return (
    <>
      <div className="overflow-hidden rounded-md border lg:hidden">
        {data.length === 0
          ? empty
          : data.map((payment) => (
              <CardPaymentMobileCard key={payment.id} payment={payment} />
            ))}
      </div>
      <div className="hidden overflow-x-auto rounded-md border lg:block">
        <Table zebra>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() =>
                    router.push(`/transactions/card-payments/${row.original.id}`)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      router.push(`/transactions/card-payments/${row.original.id}`);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="p-0">
                  {empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
