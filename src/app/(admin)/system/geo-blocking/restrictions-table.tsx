"use client";

import { Fragment, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/empty-state";

/**
 * Generic geo-restriction table — extracted from the country-only
 * `GeoBlockingContent` so the SAME row rendering (table + mobile cards +
 * expandable per-row detail) can be reused for a future "US States"
 * section once the backend ships state-level restrictions (mirrors this
 * exact 5-boolean + 3-array shape). Nothing here references "country"
 * specifically — the caller supplies `code` / `name` per row and a
 * `codeLabel` for the leading column header, so this same component can
 * render a `code = "CA"` (California) row exactly like a `code = "CA"`
 * (Canada) row.
 *
 * Row semantics (verified against a read-only prod probe of
 * `country_restrictions`, 2026-07-12 — no schema comments exist, so this
 * was confirmed empirically: every one of the 250 live rows has
 * physical_withdrawal / digital_withdrawal / gift_card_deposit /
 * promo_code_deposit = true and only the US has blocked = true):
 *   - physicalWithdrawal / digitalWithdrawal / giftCardDeposit /
 *     promoCodeDeposit: `true` = ALLOWED (the Prisma defaults are all
 *     `true`, i.e. a brand-new row starts fully open — so `false` is what
 *     disables that capability for the country).
 *   - blocked: `true` = the country is fully blocked (default `false`).
 *   - the three lockedDeposits/lockedWithdrawals arrays: a NON-EMPTY list
 *     names the currencies that are locked (blocked) for that flow.
 * The four capability booleans and `blocked` have OPPOSITE polarity (ON
 * means different things), which is exactly the ambiguity the old plain
 * "Physical / Digital / Gift Card / Promo Code / Blocked" column headers
 * hid. Every toggle below renders an explicit state caption (e.g.
 * "Allowed" / "Disabled", "Blocked" / "Not blocked") so the current state
 * reads correctly regardless of which way the switch happens to point.
 */

export type BooleanField =
  | "physical_withdrawal"
  | "digital_withdrawal"
  | "gift_card_deposit"
  | "promo_code_deposit"
  | "blocked";

export type ArrayField =
  | "locked_deposits_crypto"
  | "locked_deposits_fiat"
  | "locked_withdrawals_crypto";

export type RestrictionRowData = {
  /** ISO country code today; a US state code once that section lands. */
  code: string;
  /** Human-readable display name (country name, state name, ...). */
  name: string;
  /** Optional leading glyph (flag emoji, etc). */
  glyph?: string;
  physicalWithdrawal: boolean;
  digitalWithdrawal: boolean;
  giftCardDeposit: boolean;
  promoCodeDeposit: boolean;
  blocked: boolean;
  lockedDepositsCrypto: string[];
  lockedDepositsFiat: string[];
  lockedWithdrawalsCrypto: string[];
};

// Gift-card deposit is intentionally EXCLUDED from every restriction check below: the
// product has no gift cards, so `gift_card_deposit` is dead — the column still exists in
// the DB (we never write it) but it must not colour a country as "restricted" or add to
// any count. Same reasoning drops it from the per-country editor + classifyRow.

/** Any restriction active at all (drives the Restricted/Unrestricted split + KPI counts). */
export function isRowRestricted(row: RestrictionRowData): boolean {
  return (
    row.blocked ||
    !row.physicalWithdrawal ||
    !row.digitalWithdrawal ||
    !row.promoCodeDeposit ||
    row.lockedDepositsCrypto.length > 0 ||
    row.lockedDepositsFiat.length > 0 ||
    row.lockedWithdrawalsCrypto.length > 0
  );
}

/** Count of individually-active restrictions, shown in the per-row summary badge. */
export function countActiveRestrictions(row: RestrictionRowData): number {
  let n = 0;
  if (row.blocked) n++;
  if (!row.physicalWithdrawal) n++;
  if (!row.digitalWithdrawal) n++;
  if (!row.promoCodeDeposit) n++;
  if (row.lockedDepositsCrypto.length > 0) n++;
  if (row.lockedDepositsFiat.length > 0) n++;
  if (row.lockedWithdrawalsCrypto.length > 0) n++;
  return n;
}

// ⚠️ These `value` strings are STORED in country_restrictions.locked_deposits_crypto /
// locked_withdrawals_crypto and read by the GAME BACKEND (packy-backend) to enforce the
// lock. The first five are the confirmed live values already in prod. The six marked NEW
// are best-guess strings following the existing naming convention (full coin name; USDx
// suffixed by network) to cover all 11 supported assets — VERIFY each against packy-backend
// before relying on it, because a value the backend doesn't recognise = the lock silently
// does nothing.
export const CRYPTO_OPTIONS = [
  { value: "bitcoin", label: "Bitcoin (BTC)" },
  { value: "ethereum", label: "Ethereum (ETH)" },
  { value: "litecoin", label: "Litecoin (LTC)" }, // NEW — verify string
  { value: "solana", label: "Solana (SOL)" },
  { value: "usdt_erc20", label: "USDT (ERC20)" },
  { value: "usdt_trc20", label: "USDT (TRC20)" },
  { value: "usdt_sol", label: "USDT (Solana)" }, // NEW — verify string
  { value: "usdc_erc20", label: "USDC (ERC20)" }, // NEW — verify string
  { value: "usdc_sol", label: "USDC (Solana)" }, // NEW — verify string
  { value: "dogecoin", label: "Dogecoin (DOGE)" }, // NEW — verify string
  { value: "ripple", label: "XRP" }, // NEW — verify string
];

// Fiat deposits lock is a SINGLE on/off (one provider — no per-currency split). Stored as
// this one-element array when locked, [] when allowed. ⚠️ VERIFY the value string against
// packy-backend (same silent-no-op risk as the crypto values above).
export const FIAT_LOCK_VALUE = ["fiat"];

const RESTRICTED_BADGE = "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30";
const OPEN_BADGE = "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";

function Hint({ text }: { text: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex shrink-0 cursor-help text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              aria-label={text}
            />
          }
        >
          <Info className="size-3" />
        </TooltipTrigger>
        <TooltipContent className="max-w-[16rem] text-xs leading-relaxed">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Explicit-polarity toggle: "allow" = ON means enabled, "block" = ON means blocked. */
function ToggleField({
  label,
  hint,
  checked,
  polarity,
  onCheckedChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  polarity: "allow" | "block";
  onCheckedChange: () => void;
  disabled: boolean;
}) {
  const restrictive = polarity === "allow" ? !checked : checked;
  const stateLabel =
    polarity === "allow"
      ? checked
        ? "Allowed"
        : "Disabled"
      : checked
        ? "Blocked"
        : "Not blocked";
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-sm">
        <span className="truncate">{label}</span>
        <Hint text={hint} />
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            "text-xs font-medium",
            restrictive ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
          )}
        >
          {stateLabel}
        </span>
        <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </span>
    </div>
  );
}

// Direct-click coin chips — one click locks/unlocks a coin (no open-a-popover-then-tick
// step, which was the clunky part). A locked coin reads rose + filled; an allowed coin is a
// quiet outline. Renders all 11 supported assets so nothing is missing from the list.
function CoinLockField({
  label,
  hint,
  values,
  disabled,
  onToggleValue,
}: {
  label: string;
  hint: string;
  values: string[];
  disabled: boolean;
  onToggleValue: (optionValue: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-background/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="truncate">{label}</span>
          <Hint text={hint} />
        </span>
        <span
          className={cn(
            "shrink-0 text-xs font-medium",
            values.length > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
          )}
        >
          {values.length > 0 ? `${values.length} locked` : "None locked"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CRYPTO_OPTIONS.map((opt) => {
          const locked = values.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              aria-pressed={locked}
              onClick={() => onToggleValue(opt.value)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                locked
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RowDetail({
  row,
  isPending,
  onToggle,
  onArrayChange,
}: {
  row: RestrictionRowData;
  isPending: boolean;
  onToggle: (code: string, field: BooleanField, currentValue: boolean) => void;
  onArrayChange: (code: string, field: ArrayField, previousValues: string[], newValues: string[]) => void;
}) {
  // A fully-blocked country can't reach the site at all, so none of the finer-grained
  // deposit/withdrawal settings below take effect. Show them dimmed + click-disabled under
  // a clear note (rather than pretending they're live controls) — unblock to edit them.
  const gated = row.blocked;

  const toggleCoin = (field: ArrayField, values: string[], optionValue: string) => {
    const next = values.includes(optionValue)
      ? values.filter((v) => v !== optionValue)
      : [...values, optionValue];
    onArrayChange(row.code, field, values, next);
  };

  return (
    <div className="p-4">
      {gated && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          <Ban className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This country is fully geo-blocked — users can&apos;t reach the site, so the
            deposit / withdrawal settings below don&apos;t apply. Unblock it to edit them.
          </span>
        </div>
      )}
      <div
        className={cn(
          "grid gap-x-6 gap-y-3 md:grid-cols-2",
          gated && "pointer-events-none select-none opacity-50",
        )}
        aria-disabled={gated}
      >
        {/* ── Withdrawals ─────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Withdrawals
          </p>
          <ToggleField
            label="Item / physical withdrawal"
            hint="Withdraw via a physical / shipped card."
            polarity="allow"
            checked={row.physicalWithdrawal}
            disabled={isPending}
            onCheckedChange={() => onToggle(row.code, "physical_withdrawal", row.physicalWithdrawal)}
          />
          <ToggleField
            label="Crypto / balance withdrawal"
            hint="Withdraw digitally — crypto / balance payout."
            polarity="allow"
            checked={row.digitalWithdrawal}
            disabled={isPending}
            onCheckedChange={() => onToggle(row.code, "digital_withdrawal", row.digitalWithdrawal)}
          />
          <CoinLockField
            label="Locked withdrawal coins"
            hint="Crypto currencies users here cannot withdraw."
            values={row.lockedWithdrawalsCrypto}
            disabled={isPending}
            onToggleValue={(v) =>
              toggleCoin("locked_withdrawals_crypto", row.lockedWithdrawalsCrypto, v)
            }
          />
        </div>

        {/* ── Deposits ────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Deposits
          </p>
          <ToggleField
            label="Promo code deposit"
            hint="Deposit using a promo code."
            polarity="allow"
            checked={row.promoCodeDeposit}
            disabled={isPending}
            onCheckedChange={() => onToggle(row.code, "promo_code_deposit", row.promoCodeDeposit)}
          />
          <ToggleField
            label="Fiat deposits"
            hint="Card / fiat deposits (one provider — a single on/off, no per-currency split)."
            polarity="allow"
            checked={row.lockedDepositsFiat.length === 0}
            disabled={isPending}
            onCheckedChange={() =>
              onArrayChange(
                row.code,
                "locked_deposits_fiat",
                row.lockedDepositsFiat,
                row.lockedDepositsFiat.length > 0 ? [] : FIAT_LOCK_VALUE,
              )
            }
          />
          <CoinLockField
            label="Locked deposit coins"
            hint="Crypto currencies users here cannot deposit."
            values={row.lockedDepositsCrypto}
            disabled={isPending}
            onToggleValue={(v) => toggleCoin("locked_deposits_crypto", row.lockedDepositsCrypto, v)}
          />
        </div>
      </div>
    </div>
  );
}

function RestrictionSummaryBadge({ row }: { row: RestrictionRowData }) {
  const restricted = isRowRestricted(row);
  const count = countActiveRestrictions(row);
  return (
    <Badge variant="outline" className={restricted ? RESTRICTED_BADGE : OPEN_BADGE}>
      {restricted ? `${count} restriction${count === 1 ? "" : "s"}` : "All allowed"}
    </Badge>
  );
}

export function RestrictionsTable({
  rows,
  codeLabel = "Code",
  pendingCodes,
  onToggle,
  onArrayChange,
  emptyState,
}: {
  rows: RestrictionRowData[];
  /** Header label for the leading column — "Country" today, "State" later. */
  codeLabel?: string;
  /**
   * Country/state codes with an in-flight write. Scoped per-row (rather
   * than one table-wide `isPending` flag) so editing one row doesn't dim +
   * disable every other row's controls while its write round-trips — see
   * the "Per-row pending" note in geo-blocking-content.tsx.
   */
  pendingCodes: Set<string>;
  onToggle: (code: string, field: BooleanField, currentValue: boolean) => void;
  onArrayChange: (code: string, field: ArrayField, previousValues: string[], newValues: string[]) => void;
  emptyState: { title: string; description?: string };
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border">
        <EmptyState icon={Ban} title={emptyState.title} description={emptyState.description} compact />
      </div>
    );
  }

  return (
    <>
      {/* Desktop table (>=md) — 3 visible columns (down from the old 9)
          plus an expandable detail row per entry for the 4 finer-grained
          capability toggles + 3 locked-currency multi-selects. Keeps the
          default view scannable; the rarely-touched controls stay one
          click away instead of cluttering every row. */}
      <div className="hidden rounded-xl border overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{codeLabel}</TableHead>
              <TableHead>Blocked</TableHead>
              <TableHead>Restrictions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isOpen = expanded.has(row.code);
              const rowPending = pendingCodes.has(row.code);
              return (
                <Fragment key={row.code}>
                  <TableRow>
                    <TableCell className="font-medium">
                      <span className="flex min-w-0 items-center gap-2">
                        {row.glyph && <span className="text-base leading-none">{row.glyph}</span>}
                        <span className="min-w-0">
                          <span className="block truncate">{row.name}</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            {row.code}
                          </span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Switch
                          checked={row.blocked}
                          onCheckedChange={() => onToggle(row.code, "blocked", row.blocked)}
                          disabled={rowPending}
                        />
                        <span
                          className={cn(
                            "text-[11px] font-medium",
                            row.blocked ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
                          )}
                        >
                          {row.blocked ? "Blocked" : "Open"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggleExpanded(row.code)}
                        className="inline-flex items-center gap-1.5 rounded-full hover:opacity-80"
                        aria-expanded={isOpen}
                      >
                        <RestrictionSummaryBadge row={row} />
                        {isOpen ? (
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={3} className="bg-muted/20 p-0">
                        <RowDetail
                          row={row}
                          isPending={rowPending}
                          onToggle={onToggle}
                          onArrayChange={onArrayChange}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card list (<md) — same expand affordance as the desktop
          table, stacked instead of columned. */}
      <div className="space-y-2 md:hidden">
        {rows.map((row) => {
          const isOpen = expanded.has(row.code);
          const rowPending = pendingCodes.has(row.code);
          return (
            <div key={row.code} className="rounded-xl border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  {row.glyph && <span className="text-base leading-none">{row.glyph}</span>}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">{row.code}</div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Switch
                    checked={row.blocked}
                    onCheckedChange={() => onToggle(row.code, "blocked", row.blocked)}
                    disabled={rowPending}
                  />
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      row.blocked ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
                    )}
                  >
                    {row.blocked ? "Blocked" : "Open"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => toggleExpanded(row.code)}
                className="mt-3 flex w-full items-center justify-between rounded-lg border bg-background/40 px-3 py-2 text-left"
                aria-expanded={isOpen}
              >
                <RestrictionSummaryBadge row={row} />
                {isOpen ? (
                  <ChevronDown className="size-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </button>
              {isOpen && (
                <div className="mt-2 -mx-3 -mb-3 rounded-b-xl border-t bg-muted/20">
                  <RowDetail
                    row={row}
                    isPending={rowPending}
                    onToggle={onToggle}
                    onArrayChange={onArrayChange}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
