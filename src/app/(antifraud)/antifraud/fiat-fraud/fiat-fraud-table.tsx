import Link from "next/link";
import {
  ArrowUpRight,
  Banknote,
  CalendarClock,
  CreditCard,
  Fingerprint,
  LockKeyhole,
  MailWarning,
  ShieldAlert,
  UserRound,
} from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  FiatEmailCatchRiskType,
  FiatEmailCatchUser,
} from "@/lib/antifraud/fiat-email-catches-api";
import { ROOT_DOMAIN } from "@/lib/app-hosts";
import type { FiatFraudUserDepositTotal } from "@/lib/queries/fiat-fraud";
import { cn } from "@/lib/utils";
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

function FactBox({
  icon: Icon,
  label,
  value,
  detail,
  alert = false,
}: {
  icon: typeof Banknote;
  label: string;
  value: string;
  detail?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border/60 bg-muted/20 p-3",
        alert && "border-rose-500/25 bg-rose-500/[0.04]",
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className={cn("size-3.5 shrink-0", alert && "text-rose-500")} />
        <span className="truncate">{label}</span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-sm font-semibold tabular-nums",
          alert && "text-rose-600 dark:text-rose-400",
        )}
        title={value}
      >
        {value}
      </p>
      {detail && (
        <p
          className="mt-0.5 truncate text-[10px] text-muted-foreground"
          title={detail}
        >
          {detail}
        </p>
      )}
    </div>
  );
}

function FiatFraudCard({ row }: { row: FiatFraudUserRow }) {
  const name = row.username || "Unknown username";
  const profileHref = adminHref(`/users/${row.userId}`);
  const depositHref = row.latestDepositIntentId
    ? adminHref(
        `/transactions/card-payments/${row.latestDepositIntentId}`,
      )
    : null;

  return (
    <article className="overflow-hidden rounded-2xl border border-rose-500/20 bg-card shadow-sm">
      <div className="h-1 bg-rose-500" />
      <div className="space-y-4 p-3.5 sm:p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-rose-500/25 bg-rose-500/10 text-rose-600 dark:text-rose-400">
              <UserRound className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Link
                  href={profileHref}
                  className="truncate text-sm font-semibold hover:underline"
                >
                  {name}
                </Link>
                <Badge
                  variant="outline"
                  className="gap-1 border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                >
                  <ShieldAlert className="size-3" />
                  {row.catchCount}{" "}
                  {row.catchCount === 1 ? "catch" : "catches"}
                </Badge>
                <LockStatus locked={row.withdrawalsLocked} />
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {row.userId}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.riskTypes.map((riskType) => (
                  <Badge
                    key={riskType}
                    variant="outline"
                    className="border-rose-500/20 bg-rose-500/[0.05] text-[10px] text-rose-700 dark:text-rose-300"
                  >
                    {riskLabel(riskType)}
                  </Badge>
                ))}
                {row.sources.map((source) => (
                  <Badge
                    key={source}
                    variant="secondary"
                    className="text-[10px]"
                  >
                    {sourceLabel(source)}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <Button
              size="sm"
              variant="outline"
              render={<Link href={profileHref} />}
            >
              Open profile
              <ArrowUpRight className="size-3.5" />
            </Button>
            {depositHref && (
              <Button size="sm" render={<Link href={depositHref} />}>
                Latest deposit
                <ArrowUpRight className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <FactBox
            icon={Banknote}
            label="Total fiat deposits"
            value={depositTotal(row)}
            detail={depositCountLabel(row)}
          />
          <FactBox
            icon={CreditCard}
            label="Caught deposits"
            value={row.caughtDepositCount.toLocaleString()}
            detail={
              row.latestDepositIntentId
                ? `Latest ${row.latestDepositIntentId}`
                : "Deposit intent unavailable"
            }
            alert={row.caughtDepositCount > 0}
          />
          <FactBox
            icon={MailWarning}
            label="Latest checkout email"
            value={row.latestEmail}
            detail={`@${row.latestDomain}${
              row.emailCount > 1 ? ` · ${row.emailCount} emails total` : ""
            }`}
            alert
          />
          <FactBox
            icon={Fingerprint}
            label="Fraud evidence"
            value={`${row.riskTypes.length} signal type${
              row.riskTypes.length === 1 ? "" : "s"
            }`}
            detail={`${row.sources.length} source${
              row.sources.length === 1 ? "" : "s"
            }`}
            alert
          />
        </div>

        <div className="flex flex-col gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <CalendarClock className="size-3.5 shrink-0" />
            <span
              className="truncate"
              title={formatDateTime(row.lastOccurredAt)}
            >
              Last caught {formatRelative(row.lastOccurredAt)}
            </span>
          </div>
          <span className="truncate font-mono text-[10px]">
            {row.latestDepositIntentId ?? "No deposit intent linked"}
          </span>
        </div>
      </div>
    </article>
  );
}

export function FiatFraudTable({ rows }: { rows: FiatFraudUserRow[] }) {
  const uniqueRows = [
    ...new Map(rows.map((row) => [row.userId, row])).values(),
  ];

  if (uniqueRows.length === 0) {
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
    <div className="space-y-3">
      {uniqueRows.map((row) => (
        <FiatFraudCard key={row.userId} row={row} />
      ))}
    </div>
  );
}
