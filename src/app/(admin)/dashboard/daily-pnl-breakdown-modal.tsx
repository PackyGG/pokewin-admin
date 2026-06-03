"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";
import { fetchDailyPnlBreakdown } from "./daily-pnl-breakdown-actions";
import type {
  DailyPnlBreakdown,
  DailyPnlBreakdownRecord,
  DailyPnlBreakdownSection,
} from "@/lib/queries/dashboard-daily-pnl-breakdown";

/**
 * Per-bar drilldown modal for the dashboard's Daily-P&L (30-day) chart.
 *
 * Opening behaviour mirrors the proven lazy pattern used by the GGR
 * top-contributors expander (`revenue-stat-card.tsx`) and the reward-cost
 * "Show claimants" drilldown (`reward-costs-today-card.tsx`): a
 * `useTransition` + `useState` fetch that fires the server action
 * (`fetchDailyPnlBreakdown`) the FIRST time a given day is opened, caches the
 * result keyed by day, and reuses it on re-open with no re-fetch. The
 * dashboard's initial render never calls the action — the data loads strictly
 * on the click that opens this modal (CLAUDE.md active-timeframe / lazy rule).
 *
 * The modal is controlled by the parent `<PnlChart>` (which owns the clicked
 * day). It stays on the dashboard — no navigation, no redirect.
 *
 * Colours are House-POV per CLAUDE.md (see the per-row notes below): the
 * SUMMARY rows mirror the chart's hover tooltip exactly (signed contribution
 * to house P&L — deposits add, every liability/withdrawal term subtracts),
 * and the RECORD rows colour each raw event from the house's side (a user
 * gaining value reads rose; value flowing to the house reads emerald).
 */
export function DailyPnlBreakdownModal({
  day,
  onClose,
}: {
  /** The clicked day's YYYY-MM-DD key, or null when nothing is open. */
  day: string | null;
  onClose: () => void;
}) {
  // Cache keyed by day so re-opening a previously-viewed bar never re-fetches.
  const [cache, setCache] = React.useState<
    Record<string, DailyPnlBreakdown>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  // The day currently being fetched — so a stale in-flight response for a
  // previously-clicked bar can't overwrite the now-open one.
  const inFlightDay = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!day) return;
    setError(null);
    if (cache[day]) return; // already loaded — reuse, no fetch.
    inFlightDay.current = day;
    startTransition(async () => {
      try {
        const data = await fetchDailyPnlBreakdown(day);
        // Ignore if the user has since clicked a different bar.
        if (inFlightDay.current !== day) return;
        setCache((c) => ({ ...c, [day]: data }));
      } catch (err) {
        if (inFlightDay.current !== day) return;
        setError(
          err instanceof Error ? err.message : "Failed to load breakdown",
        );
      }
    });
    // `cache` is intentionally omitted: re-running on cache identity would
    // re-trigger after the successful set. We only want to (re)fetch when the
    // OPEN day changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const data = day ? cache[day] : undefined;

  return (
    <Dialog
      open={day !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        // Wider than the default sm modal — this is a data breakdown, not a
        // confirm dialog. Already scrollable + height-capped by the base
        // DialogContent (max-h-[85vh], overflow-y-auto).
        className="sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Daily P&amp;L · {day ?? ""}</DialogTitle>
          <DialogDescription>
            Full house-P&amp;L breakdown for this UTC day — the same components
            as the chart hover, reconciling to the bar, plus the underlying
            records per component. Colours are house-perspective.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : !data ? (
          <BreakdownLoading pending={isPending} />
        ) : (
          <DailyPnlBreakdownBody data={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BreakdownLoading({ pending }: { pending: boolean }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
      {pending && <Loader2 className="size-4 motion-safe:animate-spin" />}
      <span>Loading breakdown…</span>
    </div>
  );
}

/** The five P&L components, in the same order + icons as the chart tooltip. */
const COMPONENT_META: Array<{
  key: "deposits" | "withdrawals" | "balanceChange" | "inventoryChange" | "voucherChange";
  label: string;
  icon: LucideIcon;
}> = [
  { key: "deposits", label: "Deposits", icon: ArrowDownToLine },
  { key: "withdrawals", label: "Withdrawals", icon: ArrowUpFromLine },
  { key: "balanceChange", label: "User Balance change", icon: Wallet },
  { key: "inventoryChange", label: "Inventory change", icon: Box },
  { key: "voucherChange", label: "Voucher change", icon: Ticket },
];

function DailyPnlBreakdownBody({ data }: { data: DailyPnlBreakdown }) {
  const { summary } = data;
  const up = summary.pnl >= 0;

  // Signed contribution to house P&L — IDENTICAL to the chart tooltip:
  // deposits add; withdrawals + the three liability deltas subtract. The five
  // sum to `pnl`, so this panel reconciles to the bar height by construction.
  const contributions: Record<(typeof COMPONENT_META)[number]["key"], number> =
    {
      deposits: summary.deposits,
      withdrawals: -summary.withdrawals,
      balanceChange: -summary.balanceChange,
      inventoryChange: -summary.inventoryChange,
      voucherChange: -summary.voucherChange,
    };

  return (
    <div className="space-y-4">
      {/* ── Summary: the five components + the P&L bottom line. Mirrors the
            chart hover tooltip exactly. ── */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
        <div className="grid gap-1.5">
          {COMPONENT_META.map((m) => (
            <SummaryRow
              key={m.key}
              label={m.label}
              icon={m.icon}
              contribution={contributions[m.key]}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2">
          <span className="text-sm font-semibold">House P&amp;L</span>
          <span
            className={cn(
              "font-mono text-sm font-bold tabular-nums",
              up
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400",
            )}
          >
            {up ? "+" : "−"}
            {formatCurrency(Math.abs(summary.pnl))}
          </span>
        </div>
      </div>

      {/* ── Underlying records, sectioned by component. ── */}
      <RecordSection
        title="Deposits"
        icon={ArrowDownToLine}
        section={data.deposits}
        rowCap={data.rowCap}
        emptyLabel="No deposits this day."
      />
      <RecordSection
        title="Withdrawals"
        icon={ArrowUpFromLine}
        section={data.withdrawals}
        rowCap={data.rowCap}
        emptyLabel="No withdrawals this day."
      />
      <RecordSection
        title="Balance-change ledger events"
        icon={Wallet}
        section={data.balanceChanges}
        rowCap={data.rowCap}
        emptyLabel="No balance-change ledger events this day."
      />
      <RecordSection
        title="Inventory changes"
        icon={Box}
        section={data.inventoryChanges}
        rowCap={data.rowCap}
        emptyLabel="No inventory changes this day."
      />
      <RecordSection
        title="Voucher changes"
        icon={Ticket}
        section={data.voucherChanges}
        rowCap={data.rowCap}
        emptyLabel="No voucher changes this day."
      />
    </div>
  );
}

/**
 * One summary line — icon chip, label, and the SIGNED contribution to house
 * P&L coloured House-POV (a positive contribution / shrinking liability reads
 * emerald; a negative one rose). Identical to the chart tooltip's rows.
 */
function SummaryRow({
  label,
  icon: Icon,
  contribution,
}: {
  label: string;
  icon: LucideIcon;
  contribution: number;
}) {
  const positive = contribution >= 0;
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </span>
      <span
        className={cn(
          "font-mono font-medium tabular-nums",
          positive
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {positive ? "+" : "−"}
        {formatCurrency(Math.abs(contribution))}
      </span>
    </div>
  );
}

function RecordSection({
  title,
  icon: Icon,
  section,
  rowCap,
  emptyLabel,
}: {
  title: string;
  icon: LucideIcon;
  section: DailyPnlBreakdownSection;
  rowCap: number;
  emptyLabel: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          {title}
        </h3>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {section.capped
            ? `top ${rowCap} of ${section.totalCount}`
            : `${section.totalCount}`}
        </span>
      </div>
      {section.rows.length === 0 ? (
        <p className="rounded-md border border-border/50 px-3 py-2 text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/50">
          {section.rows.map((r) => (
            <RecordRow key={`${r.kind}-${r.id}`} row={r} />
          ))}
        </ul>
      )}
      {section.capped && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          List truncated to the {rowCap} largest by magnitude — the summary
          total above is computed over all {section.totalCount} records.
        </p>
      )}
    </div>
  );
}

/**
 * One underlying record. House-POV colouring (CLAUDE.md): a positive raw
 * amount means the user GAINED value (a balance credit, an obtained card, an
 * issued voucher) → 🔴 rose (a house liability/loss); a negative amount means
 * value flowed back to the house (a withdrawal, a wager debit, a sold/claimed
 * disposal) → 🟢 emerald. Deposits are the deliberate exception — a positive
 * amount that is the user paying capital IN, which is house-favourable, so the
 * `deposit` kind is forced emerald.
 */
function RecordRow({ row }: { row: DailyPnlBreakdownRecord }) {
  const formatDateTime = useFormatDateTime();
  const isDeposit = row.kind === "deposit";
  // House-POV: deposit → emerald; otherwise sign of the raw amount flips
  // (user gain = positive = rose; value to house = negative = emerald).
  const housePositive = isDeposit ? true : row.amount < 0;
  const username = row.username ?? `${row.userId.slice(0, 8)}…`;
  return (
    <li className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs hover:bg-muted/40">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={`/users/${row.userId}`}
          className="truncate font-medium text-foreground hover:underline"
        >
          {username}
        </Link>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate font-mono">{prettyKind(row.kind)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{formatDateTime(row.at)}</span>
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 font-mono font-semibold tabular-nums",
          housePositive
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {row.amount >= 0 ? "+" : "−"}
        {formatCurrency(Math.abs(row.amount))}
      </span>
    </li>
  );
}

/** Humanise a ledger type / inventory-voucher kind for display. */
function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ");
}
