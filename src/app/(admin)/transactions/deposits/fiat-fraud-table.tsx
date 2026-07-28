import Link from "next/link";
import { LockKeyhole, MailWarning, ShieldAlert } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FiatEmailCatch } from "@/lib/antifraud/fiat-email-catches-api";
import type { FiatFraudDepositSummary } from "@/lib/queries/fiat-fraud";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";

export type FiatFraudRow = FiatEmailCatch & {
  deposit: FiatFraudDepositSummary | null;
};

function riskLabel(riskType: FiatEmailCatch["riskType"]): string {
  if (riskType === "blacklisted_domain") return "Blocked email domain";
  if (riskType === "gmail_dot_fragmentation") return "Dot-fragmented Gmail";
  return "Suspicious deposit cluster";
}

function sourceLabel(source: string): string {
  return source
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function paymentAmount(row: FiatFraudRow): string {
  const cents =
    row.deposit?.actualCustomerTotalCents ??
    row.deposit?.requestedAmountCents ??
    null;
  return cents === null ? "—" : formatCurrency(cents / 100);
}

function DepositStatus({ row }: { row: FiatFraudRow }) {
  const status =
    row.deposit?.providerPaymentStatus ?? row.deposit?.status ?? "Unavailable";
  return (
    <Badge variant="outline" className="capitalize">
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

function LockStatus({ locked }: { locked: boolean }) {
  return locked ? (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    >
      <LockKeyhole className="size-3" />
      Withdrawals locked
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    >
      Lock pending
    </Badge>
  );
}

export function FiatFraudTable({ rows }: { rows: FiatFraudRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-card">
        <EmptyState
          icon={ShieldAlert}
          title="No fraudulent fiat deposits found"
          description="No durable catches match the current search and filters."
          compact
        />
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Table zebra>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Fraud signal</TableHead>
              <TableHead>Checkout email</TableHead>
              <TableHead>Deposit</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead>Containment</TableHead>
              <TableHead>Caught</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="bg-red-500/[0.025]">
                <TableCell>
                  <Link
                    href={`/users/${row.userId}`}
                    className="block max-w-40 hover:underline"
                  >
                    <span className="block truncate font-medium">
                      {row.username || "Unknown username"}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {row.userId}
                    </span>
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="max-w-48 space-y-1">
                    <Badge
                      variant="outline"
                      className="gap-1 border-red-600/40 bg-red-600/15 font-semibold text-red-700 dark:text-red-300"
                    >
                      <ShieldAlert className="size-3" />
                      100 · Critical
                    </Badge>
                    <p className="truncate text-[11px]" title={riskLabel(row.riskType)}>
                      {riskLabel(row.riskType)}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {sourceLabel(row.source)}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="max-w-56">
                    <p className="truncate text-xs" title={row.checkoutEmail}>
                      {row.checkoutEmail}
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      @{row.domain}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  {row.depositIntentId ? (
                    <Link
                      href={`/transactions/card-payments/${row.depositIntentId}`}
                      className="block max-w-44 hover:underline"
                    >
                      <span className="block font-medium tabular-nums">
                        {paymentAmount(row)}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {row.depositIntentId}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Intent unavailable
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <DepositStatus row={row} />
                </TableCell>
                <TableCell>
                  <LockStatus locked={row.withdrawalsLocked} />
                </TableCell>
                <TableCell>
                  <span title={formatDateTime(row.occurredAt)}>
                    {formatRelative(row.occurredAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card md:hidden">
        {rows.map((row) => (
          <article
            key={row.id}
            className="space-y-3 border-b border-border/60 p-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <Link href={`/users/${row.userId}`} className="min-w-0 hover:underline">
                <p className="truncate text-sm font-semibold">
                  {row.username || "Unknown username"}
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {row.userId}
                </p>
              </Link>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {paymentAmount(row)}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className="gap-1 border-red-600/40 bg-red-600/15 text-red-700 dark:text-red-300"
              >
                <ShieldAlert className="size-3" />
                100 · Critical
              </Badge>
              <LockStatus locked={row.withdrawalsLocked} />
              <DepositStatus row={row} />
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <MailWarning className="mt-0.5 size-3.5 shrink-0 text-red-500" />
              <div className="min-w-0">
                <p className="truncate text-xs">{row.checkoutEmail}</p>
                <p className="text-[11px] text-muted-foreground">
                  {riskLabel(row.riskType)} · {sourceLabel(row.source)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              {row.depositIntentId ? (
                <Link
                  href={`/transactions/card-payments/${row.depositIntentId}`}
                  className="truncate font-mono hover:underline"
                >
                  {row.depositIntentId}
                </Link>
              ) : (
                <span>Intent unavailable</span>
              )}
              <span className="shrink-0" title={formatDateTime(row.occurredAt)}>
                {formatRelative(row.occurredAt)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
