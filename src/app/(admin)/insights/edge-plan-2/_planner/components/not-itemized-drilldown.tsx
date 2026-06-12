"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import {
  getNotItemizedAdjustmentDrilldown,
  type NotItemizedDrilldownResult,
} from "../../_drilldown-actions";
import type {
  AdjustmentCategoryRow,
  NotItemizedDrilldownV2,
  NotItemizedRowV2,
  NotItemizedTotalsV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";

/**
 * NotItemizedDrilldownRow — the adjustments panel's NULL-category bucket row,
 * now EXPANDABLE (owner spec #12).
 *
 * LAZY by construction (Active-Timeframe-Only): the server action
 * (`getNotItemizedAdjustmentDrilldown`) fires only on the FIRST expand —
 * never on the initial page render — and the result is kept in state, so
 * collapse/re-expand does not refetch. The action reads the SAME window +
 * canonical customer scope + NULL-category predicate as the panel's bucket
 * row, so the drill-down totals reconcile EXACTLY with the row above (the
 * UI re-checks that identity live and says so loudly either way).
 *
 * House-POV: a credit (> 0) pays the user → rose; a debit (< 0) claws back →
 * emerald.
 */
export function NotItemizedDrilldownRow({ row }: { row: AdjustmentCategoryRow }) {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<NotItemizedDrilldownV2 | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const load = React.useCallback(() => {
    startTransition(async () => {
      const res: NotItemizedDrilldownResult =
        await getNotItemizedAdjustmentDrilldown();
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Lazy: fetch exactly once, on the first expand.
    if (next && data == null && error == null && !pending) load();
  };

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={toggle}
        data-state={open ? "open" : "closed"}
      >
        <TableCell className="font-medium">
          <button
            type="button"
            onClick={(e) => {
              // The row handles the click — keep the button for keyboard/AT.
              e.stopPropagation();
              toggle();
            }}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-left font-medium hover:underline"
          >
            <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {row.label}
          </button>
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
            (NULL category · click to drill down)
          </span>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatNumber(row.count)}
        </TableCell>
        <TableCell
          className={cn(
            "text-right tabular-nums",
            row.creditsUsd > 0 ? TEXT_TONE.rose : "text-muted-foreground",
          )}
        >
          {formatCurrency(row.creditsUsd)}
        </TableCell>
        <TableCell
          className={cn(
            "text-right tabular-nums",
            row.debitsUsd > 0 ? TEXT_TONE.emerald : "text-muted-foreground",
          )}
        >
          {formatCurrency(row.debitsUsd)}
        </TableCell>
        <TableCell className="text-right">
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            not counted
          </Badge>
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/20 p-3 align-top">
            {pending ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground motion-safe:animate-pulse">
                Loading the not-itemized rows (one bounded read, same window
                and scope as the row above)…
              </p>
            ) : error != null ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
                {error}{" "}
                <button
                  type="button"
                  onClick={load}
                  className="ml-1 inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
                >
                  <RotateCcw className="size-3" aria-hidden />
                  Retry
                </button>
              </div>
            ) : data != null ? (
              <DrilldownBody data={data} bucketRow={row} />
            ) : null}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ─── Expanded body ───────────────────────────────────────────────────────────

function DrilldownBody({
  data,
  bucketRow,
}: {
  data: NotItemizedDrilldownV2;
  bucketRow: AdjustmentCategoryRow;
}) {
  const cents = (v: number) => Math.round(v * 100);
  const reconciles =
    data.totals.count === bucketRow.count &&
    cents(data.totals.creditsUsd) === cents(bucketRow.creditsUsd) &&
    cents(data.totals.debitsUsd) === cents(bucketRow.debitsUsd);

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Not itemized — drill-down · {data.windowLabel}
      </p>

      {data.truncated && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          The bounded fetch hit its row cap — the drill-down under-counts
          this window. Narrow the window before trusting these totals.
        </div>
      )}

      {/* Totals strip — reconciles with the bucket row above. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TotalsTile label="Rows" value={formatNumber(data.totals.count)} />
        <TotalsTile
          label="Credits (house pays)"
          value={formatCurrency(data.totals.creditsUsd)}
          valueClassName={TEXT_TONE.rose}
        />
        <TotalsTile
          label="Debits (clawed back)"
          value={formatCurrency(data.totals.debitsUsd)}
          valueClassName={TEXT_TONE.emerald}
        />
        <TotalsTile
          label="Net out the door"
          value={formatCurrency(data.totals.netUsd)}
          valueClassName={netTone(data.totals.netUsd)}
        />
      </div>

      {reconciles ? (
        <p className={cn("text-[11px]", TEXT_TONE.emerald)}>
          ✓ Reconciles exactly with the “Not itemized” row above (count,
          credits and debits match — same window, scope and predicate).
        </p>
      ) : (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          These totals differ from the bucket row above — most likely cache
          skew between the panel’s baseline snapshot and this live read.
          Refresh the page to realign before comparing the figures.
        </div>
      )}

      <Tabs defaultValue="largest">
        <TabsList>
          <TabsTrigger value="largest" className="text-xs">
            Largest 20
          </TabsTrigger>
          <TabsTrigger value="by-month" className="text-xs">
            By month
          </TabsTrigger>
          <TabsTrigger value="top-users" className="text-xs">
            Top users
          </TabsTrigger>
          <TabsTrigger value="by-reason" className="text-xs">
            By reason
          </TabsTrigger>
        </TabsList>

        <TabsContent value="largest">
          <LargestRowsTable rows={data.largest} />
        </TabsContent>

        <TabsContent value="by-month">
          <GroupTotalsTable
            labelHeader="Month"
            rows={data.byMonth.map((g) => ({
              key: g.month,
              label: g.month,
              totals: g,
            }))}
          />
        </TabsContent>

        <TabsContent value="top-users">
          <GroupTotalsTable
            labelHeader={`User (top ${data.topUsersByNet.length} by |net|)`}
            rows={data.topUsersByNet.map((g) => ({
              key: g.userId,
              label: <UserCell userId={g.userId} username={g.username} />,
              totals: g,
            }))}
          />
        </TabsContent>

        <TabsContent value="by-reason">
          <GroupTotalsTable
            labelHeader="Detected reason key"
            rows={data.byReasonKey.map((g) => ({
              key: g.reasonKey,
              label: (
                <Badge variant="outline" className="text-[10px]">
                  {g.reasonKey}
                </Badge>
              ),
              totals: g,
            }))}
          />
        </TabsContent>
      </Tabs>

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Every grouping sums to the same totals — Σ {formatNumber(data.totals.count)}{" "}
        rows · {formatCurrency(data.totals.creditsUsd)} credits ·{" "}
        {formatCurrency(data.totals.debitsUsd)} debits. Reason keys are
        detected from the rows’ descriptions/metadata; the admin column is the
        ADMIN-DB cross-reference (rows older than the meta table show “—”).
      </p>
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function TotalsTile({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border bg-background/40 px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </p>
    </div>
  );
}

/** House-POV tone for a NET figure: net out → rose, net clawed back → emerald. */
function netTone(netUsd: number): string {
  if (!Number.isFinite(netUsd) || Math.abs(netUsd) < 0.005) {
    return "text-muted-foreground";
  }
  return netUsd > 0 ? TEXT_TONE.rose : TEXT_TONE.emerald;
}

/** Signed amount, House-POV: credit (+, house pays) rose · debit (−) emerald. */
function SignedAmount({ usd }: { usd: number }) {
  if (!Number.isFinite(usd) || Math.abs(usd) < 0.005) {
    // Never render "−$0.00".
    return <span className="tabular-nums text-muted-foreground">$0.00</span>;
  }
  const credit = usd > 0;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        credit ? TEXT_TONE.rose : TEXT_TONE.emerald,
      )}
    >
      {credit ? "+" : "−"}
      {formatCurrency(Math.abs(usd))}
    </span>
  );
}

function UserCell({
  userId,
  username,
}: {
  userId: string;
  username: string | null;
}) {
  return (
    <span className="inline-flex min-w-0 flex-col" title={userId}>
      <span className="truncate text-xs font-medium">
        {username ?? "(unknown username)"}
      </span>
      <span className="truncate font-mono text-[10px] text-muted-foreground">
        {userId}
      </span>
    </span>
  );
}

function LargestRowsTable({ rows }: { rows: NotItemizedRowV2[] }) {
  if (rows.length === 0) {
    return (
      <p className="px-1 py-3 text-xs text-muted-foreground">
        No not-itemized rows in this window.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Reason key</TableHead>
          <TableHead>Admin</TableHead>
          <TableHead>Note</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.ledgerTxId}>
            <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {formatDateTime(r.createdAtIso)}
            </TableCell>
            <TableCell>
              <UserCell userId={r.userId} username={r.username} />
            </TableCell>
            <TableCell className="text-right">
              <SignedAmount usd={r.amountUsd} />
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="text-[10px]">
                {r.reasonKey}
              </Badge>
            </TableCell>
            <TableCell className="text-xs">
              {r.adminUsername != null ? (
                <span className="inline-flex min-w-0 flex-col">
                  <span className="truncate font-medium">{r.adminUsername}</span>
                  {r.adminCategory != null && (
                    <span className="truncate text-[10px] text-muted-foreground">
                      {r.adminCategory}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell
              className="max-w-[220px] truncate text-xs text-muted-foreground"
              title={r.adminReason ?? r.description ?? undefined}
            >
              {r.adminReason ?? r.description ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function GroupTotalsTable({
  labelHeader,
  rows,
}: {
  labelHeader: string;
  rows: { key: string; label: React.ReactNode; totals: NotItemizedTotalsV2 }[];
}) {
  if (rows.length === 0) {
    return (
      <p className="px-1 py-3 text-xs text-muted-foreground">
        Nothing to group in this window.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{labelHeader}</TableHead>
          <TableHead className="text-right">Count</TableHead>
          <TableHead className="text-right">Credits</TableHead>
          <TableHead className="text-right">Debits</TableHead>
          <TableHead className="text-right">Net</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((g) => (
          <TableRow key={g.key}>
            <TableCell>{g.label}</TableCell>
            <TableCell className="text-right text-xs tabular-nums">
              {formatNumber(g.totals.count)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right text-xs tabular-nums",
                g.totals.creditsUsd > 0 ? TEXT_TONE.rose : "text-muted-foreground",
              )}
            >
              {formatCurrency(g.totals.creditsUsd)}
            </TableCell>
            <TableCell
              className={cn(
                "text-right text-xs tabular-nums",
                g.totals.debitsUsd > 0
                  ? TEXT_TONE.emerald
                  : "text-muted-foreground",
              )}
            >
              {formatCurrency(g.totals.debitsUsd)}
            </TableCell>
            <TableCell
              className={cn("text-right text-xs tabular-nums", netTone(g.totals.netUsd))}
            >
              {formatCurrency(g.totals.netUsd)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
