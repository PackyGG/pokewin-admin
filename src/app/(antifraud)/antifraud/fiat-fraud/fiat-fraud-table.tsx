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
import type {
  FiatEmailCatchRiskType,
  FiatEmailCatchUser,
} from "@/lib/antifraud/fiat-email-catches-api";
import { ROOT_DOMAIN } from "@/lib/app-hosts";
import type { FiatFraudUserDepositTotal } from "@/lib/queries/fiat-fraud";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";

export type FiatFraudUserRow = FiatEmailCatchUser & {
  depositTotals: FiatFraudUserDepositTotal | null;
};

function adminHref(path: string): string {
  return `https://${ROOT_DOMAIN}${path}`;
}

function riskLabel(riskType: FiatEmailCatchRiskType): string {
  if (riskType === "blacklisted_domain") return "Blocked email domain";
  if (riskType === "gmail_dot_fragmentation") return "Dot-fragmented Gmail";
  return "Suspicious deposit cluster";
}

function sourceLabel(source: string): string {
  return source
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function depositTotal(row: FiatFraudUserRow): string {
  return row.depositTotals === null
    ? "—"
    : formatCurrency(row.depositTotals.paidTotalCents / 100);
}

function depositCountLabel(row: FiatFraudUserRow): string {
  if (row.depositTotals === null) return "Totals unavailable";
  const count = row.depositTotals.paidDepositCount;
  return `${count} paid fiat deposit${count === 1 ? "" : "s"}`;
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

export function FiatFraudTable({ rows }: { rows: FiatFraudUserRow[] }) {
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
              <TableHead>Fraud signals</TableHead>
              <TableHead>Checkout email</TableHead>
              <TableHead>Caught deposits</TableHead>
              <TableHead>Total fiat deposits</TableHead>
              <TableHead>Containment</TableHead>
              <TableHead>Last caught</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId} className="bg-red-500/[0.025]">
                <TableCell>
                  <Link
                    href={adminHref(`/users/${row.userId}`)}
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
                  <div className="max-w-52 space-y-1">
                    <Badge
                      variant="outline"
                      className="gap-1 border-red-600/40 bg-red-600/15 font-semibold text-red-700 dark:text-red-300"
                    >
                      <ShieldAlert className="size-3" />
                      {row.catchCount}{" "}
                      {row.catchCount === 1 ? "catch" : "catches"}
                    </Badge>
                    {row.riskTypes.map((riskType) => (
                      <p
                        key={riskType}
                        className="truncate text-[11px]"
                        title={riskLabel(riskType)}
                      >
                        {riskLabel(riskType)}
                      </p>
                    ))}
                    <p className="truncate text-[10px] text-muted-foreground">
                      {row.sources.map(sourceLabel).join(" · ")}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="max-w-56">
                    <p className="truncate text-xs" title={row.latestEmail}>
                      {row.latestEmail}
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      @{row.latestDomain}
                      {row.emailCount > 1
                        ? ` · +${row.emailCount - 1} more`
                        : ""}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  {row.latestDepositIntentId ? (
                    <Link
                      href={adminHref(
                        `/transactions/card-payments/${row.latestDepositIntentId}`,
                      )}
                      className="block max-w-44 hover:underline"
                    >
                      <span className="block font-medium tabular-nums">
                        {row.caughtDepositCount} caught
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {row.latestDepositIntentId}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Intent unavailable
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="block font-medium tabular-nums">
                    {depositTotal(row)}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {depositCountLabel(row)}
                  </span>
                </TableCell>
                <TableCell>
                  <LockStatus locked={row.withdrawalsLocked} />
                </TableCell>
                <TableCell>
                  <span title={formatDateTime(row.lastOccurredAt)}>
                    {formatRelative(row.lastOccurredAt)}
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
            key={row.userId}
            className="space-y-3 border-b border-border/60 p-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <Link
                href={adminHref(`/users/${row.userId}`)}
                className="min-w-0 hover:underline"
              >
                <p className="truncate text-sm font-semibold">
                  {row.username || "Unknown username"}
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {row.userId}
                </p>
              </Link>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">
                  {depositTotal(row)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {depositCountLabel(row)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className="gap-1 border-red-600/40 bg-red-600/15 text-red-700 dark:text-red-300"
              >
                <ShieldAlert className="size-3" />
                {row.catchCount} {row.catchCount === 1 ? "catch" : "catches"}
              </Badge>
              <LockStatus locked={row.withdrawalsLocked} />
            </div>
            <div className="flex min-w-0 items-start gap-2">
              <MailWarning className="mt-0.5 size-3.5 shrink-0 text-red-500" />
              <div className="min-w-0">
                <p className="truncate text-xs">
                  {row.latestEmail}
                  {row.emailCount > 1 ? ` (+${row.emailCount - 1} more)` : ""}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {row.riskTypes.map(riskLabel).join(" · ")} ·{" "}
                  {row.sources.map(sourceLabel).join(" · ")}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              {row.latestDepositIntentId ? (
                <Link
                  href={adminHref(
                    `/transactions/card-payments/${row.latestDepositIntentId}`,
                  )}
                  className="truncate font-mono hover:underline"
                >
                  {row.caughtDepositCount} caught ·{" "}
                  {row.latestDepositIntentId}
                </Link>
              ) : (
                <span>Intent unavailable</span>
              )}
              <span
                className="shrink-0"
                title={formatDateTime(row.lastOccurredAt)}
              >
                {formatRelative(row.lastOccurredAt)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
