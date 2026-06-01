"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Info, Loader2, Ticket, Users } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type {
  RewardBreakdownRow,
  RewardCategoryKey,
  RewardTopPromoCodeRow,
  RewardTopRecipientRow,
} from "@/lib/queries/rewards-analytics";
import {
  fetchRewardCategoryTopRecipients,
  fetchRewardsTopPromoCodes,
} from "./drilldown-actions";

/**
 * Drilldown popover anchored on every reward rollup tile on
 * /rewards/analytics. Mirrors the GGR breakdown popover shipped on
 * /dashboard (commits 2a21491 + 90d8f09):
 *   • Per-ledger-type rows up-front (cheap, computed on the server with
 *     the page).
 *   • Lazy expanders for the per-user recipient list (always) and the
 *     per-code list (only on the Bonuses & Promos popover) — fired via
 *     server action on click so the heavier GROUP BY user_id /
 *     promo_code_id queries don't run on every page render.
 *
 * House-POV per CLAUDE.md: every dollar here is money the house GIVES
 * users, so all amounts render rose.
 *
 * Trigger lives in the `action` slot of `<KpiTile>` (already there for
 * this exact purpose).
 */

export type RewardTileDrilldownProps = {
  /**
   * Category key driving the breakdown / recipients query. Passing
   * `"all"` opens the site-wide rollup popover anchored on the Total
   * Rewards tile (no per-code expander, recipients query scans every
   * reward ledger type).
   */
  category: RewardCategoryKey | "all";
  /** Display label shown in the popover header (e.g. "Bonuses & Promos"). */
  label: string;
  /** Pre-loaded per-ledger-type rows for this category. Always non-null. */
  breakdownRows: RewardBreakdownRow[];
  /** Total of the breakdown rows — same as the headline tile amount. */
  total: number;
  /** Sum of row counts — payouts in the category for the period. */
  count: number;
  /** Sanitized period string (`"today"` / `"7d"` / `"30d"` / `"all"`). */
  periodParam: string;
  /** Friendly period label (e.g. "Last 7 days") — shown under the header. */
  periodLabel: string;
};

export function RewardTileDrilldown({
  category,
  label,
  breakdownRows,
  total,
  count,
  periodParam,
  periodLabel,
}: RewardTileDrilldownProps) {
  // Suppress zero-total rows so quiet windows (e.g. 24h with no
  // promo redemptions) don't render empty placeholders. The header
  // total still reflects the full sum either way.
  const rows = breakdownRows.filter((r) => r.total > 0);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Show breakdown for ${label}`}
            title={`Show breakdown for ${label}`}
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2.5 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {periodLabel} · {formatNumber(count)} payouts. Staff +
            excluded users dropped — same filter as the headline tile.
          </p>
        </div>

        {/* Per-ledger-type rows + total header. House-POV rose
            because every dollar is money flowing OUT to users. */}
        <BreakdownSection rows={rows} total={total} />

        {/* Lazy expander — top recipients in this category. Fires
            the server action on first click and caches the rows in
            local state so close→open within the same popover
            instance doesn't re-fetch. */}
        <LazyExpander
          icon={Users}
          label="top 10 recipients"
          load={async () =>
            fetchRewardCategoryTopRecipients(periodParam, category, 10)
          }
          renderRows={(rows) => <RecipientRows rows={rows} />}
        />

        {/* Per-code expander — only meaningful on the Bonuses &
            Promos popover (promo codes are the only reward type
            with a code-level grouping that's interesting to admins:
            gift cards are one-shot, deposit bonuses are inline).
            Skipped on every other category so we don't fire an
            empty query. */}
        {category === "bonuses" && (
          <LazyExpander
            icon={Ticket}
            label="top 10 promo codes"
            load={async () => fetchRewardsTopPromoCodes(periodParam, 10)}
            renderRows={(rows) => <PromoCodeRows rows={rows} />}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The per-ledger-type breakdown rows + header total. Rose tint on every
 * amount per CLAUDE.md's House-POV rule (rewards are money out of the
 * house treasury).
 */
function BreakdownSection({
  rows,
  total,
}: {
  rows: RewardBreakdownRow[];
  total: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>
          By ledger type
          {rows.length > 0 && (
            <span className="ml-1 text-muted-foreground/60">
              · {rows.length}
            </span>
          )}
        </span>
        <span className="font-semibold tabular-nums text-rose-500 dark:text-rose-400">
          {formatCurrency(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-1 text-[10px] text-muted-foreground/60">
          No activity in this window.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li
              key={r.type}
              className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                  · {formatNumber(r.count)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-rose-500/90 dark:text-rose-400/90">
                {formatCurrency(r.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Generic "Show / Hide ___" expander. Fires `load()` on first open,
 * caches the result, reuses it on subsequent toggles. Used for both
 * the recipients list (everywhere) and the promo-code list (Bonuses
 * popover only) so the loading + error + empty UX is identical
 * across drilldowns.
 *
 * `renderRows` is the only divergent piece between the two cases —
 * it gets the typed array and renders the appropriate row shape.
 */
function LazyExpander<T>({
  icon: Icon,
  label,
  load,
  renderRows,
}: {
  icon: React.ElementType;
  label: string;
  load: () => Promise<T[]>;
  renderRows: (rows: T[]) => React.ReactNode;
}) {
  const [state, setState] = useState<{
    open: boolean;
    rows: T[] | null;
    error: string | null;
  }>({ open: false, rows: null, error: null });
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    if (state.open) {
      setState((s) => ({ ...s, open: false }));
      return;
    }
    if (state.rows) {
      setState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const rows = await load();
        setState({ open: true, rows, error: null });
      } catch (err) {
        setState({
          open: true,
          rows: null,
          error: err instanceof Error ? err.message : `Failed to load ${label}`,
        });
      }
    });
  };

  return (
    <div className="border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={handleToggle}
        disabled={isPending}
        className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon className="size-3" />
          {state.open ? "Hide" : "Show"} {label}
        </span>
        {isPending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ChevronDown
            className={cn(
              "size-3 transition-transform",
              state.open && "rotate-180",
            )}
          />
        )}
      </button>
      {state.open && (
        <div className="mt-1.5">
          {state.error ? (
            <p className="px-1.5 py-2 text-[10px] text-rose-400">
              {state.error}
            </p>
          ) : state.rows && state.rows.length > 0 ? (
            renderRows(state.rows)
          ) : (
            <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
              No activity in this window.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One row per user inside the recipients expander. Rank + username +
 * payout count + total. Whole row links to /users/<id> so admins can
 * drill from "the bonuses bucket" → "this user's full bonus history".
 */
function RecipientRows({ rows }: { rows: RewardTopRecipientRow[] }) {
  return (
    <ul className="space-y-0.5">
      {rows.map((r, idx) => {
        const display = r.username ?? `${r.userId.slice(0, 6)}…`;
        return (
          <li key={r.userId}>
            <Link
              href={`/users/${r.userId}`}
              className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                  {idx + 1}.
                </span>
                <span className="truncate font-medium">{display}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className="text-muted-foreground/60">
                  {formatNumber(r.count)}{" "}
                  {r.count === 1 ? "payout" : "payouts"}
                </span>
                <span className="min-w-[64px] text-right font-semibold text-rose-500 dark:text-rose-400">
                  {formatCurrency(r.total)}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Row inside the promo-code expander. Falls back to the code id when
 * the displayable code text isn't on the promo_codes row (very old
 * codes pre-metadata may lack it). The whole row links to the promo
 * code detail page (`/promo-codes/[id]`) so admins can drill into
 * who redeemed it.
 */
function PromoCodeRows({ rows }: { rows: RewardTopPromoCodeRow[] }) {
  return (
    <ul className="space-y-0.5">
      {rows.map((r, idx) => {
        const display = r.code ?? `${r.codeId.slice(0, 6)}…`;
        return (
          <li key={r.codeId}>
            <Link
              href={`/promo-codes/${r.codeId}`}
              className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                  {idx + 1}.
                </span>
                <span className="truncate font-mono font-medium">
                  {display}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                <span className="text-muted-foreground/60">
                  {formatNumber(r.redemptions)}{" "}
                  {r.redemptions === 1 ? "redeem" : "redeems"}
                </span>
                <span className="min-w-[64px] text-right font-semibold text-rose-500 dark:text-rose-400">
                  {formatCurrency(r.total)}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
