"use client";

import { Fragment, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

/** Any restriction active at all (drives the Restricted/Unrestricted split + KPI counts). */
export function isRowRestricted(row: RestrictionRowData): boolean {
  return (
    row.blocked ||
    !row.physicalWithdrawal ||
    !row.digitalWithdrawal ||
    !row.giftCardDeposit ||
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
  if (!row.giftCardDeposit) n++;
  if (!row.promoCodeDeposit) n++;
  if (row.lockedDepositsCrypto.length > 0) n++;
  if (row.lockedDepositsFiat.length > 0) n++;
  if (row.lockedWithdrawalsCrypto.length > 0) n++;
  return n;
}

export const CRYPTO_OPTIONS = [
  { value: "bitcoin", label: "Bitcoin" },
  { value: "ethereum", label: "Ethereum" },
  { value: "solana", label: "Solana" },
  { value: "usdt_erc20", label: "USDT (ERC20)" },
  { value: "usdt_trc20", label: "USDT (TRC20)" },
];

export const FIAT_OPTIONS = [
  { value: "gift_card", label: "Gift Card" },
  { value: "promo_code", label: "Promo Code" },
];

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

function CurrencyField({
  label,
  hint,
  values,
  options,
  disabled,
  onToggleValue,
}: {
  label: string;
  hint: string;
  values: string[];
  options: { value: string; label: string }[];
  disabled: boolean;
  onToggleValue: (optionValue: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-sm">
        <span className="truncate">{label}</span>
        <Hint text={hint} />
      </span>
      <Popover>
        <PopoverTrigger
          disabled={disabled}
          className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted"
        >
          {values.length === 0 ? (
            <span className="text-muted-foreground">None locked</span>
          ) : (
            <span className="font-medium text-rose-600 dark:text-rose-400">
              {values.length} locked
            </span>
          )}
          <ChevronDown className="h-3 w-3" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 p-2">
          <div className="flex flex-col gap-1">
            {options.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-muted"
              >
                <Checkbox
                  checked={values.includes(opt.value)}
                  onCheckedChange={() => onToggleValue(opt.value)}
                  disabled={disabled}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const BOOL_HINTS: Record<Exclude<BooleanField, "blocked">, { label: string; hint: string }> = {
  physical_withdrawal: {
    label: "Physical withdrawal",
    hint: "Whether users in this country can withdraw via a physical / shipped card.",
  },
  digital_withdrawal: {
    label: "Digital withdrawal",
    hint: "Whether users in this country can withdraw digitally (crypto, bank, etc).",
  },
  gift_card_deposit: {
    label: "Gift card deposit",
    hint: "Whether users in this country can deposit using a gift card.",
  },
  promo_code_deposit: {
    label: "Promo code deposit",
    hint: "Whether users in this country can deposit using a promo code.",
  },
};

const ARRAY_HINTS: Record<ArrayField, { label: string; hint: string; options: typeof CRYPTO_OPTIONS }> = {
  locked_deposits_crypto: {
    label: "Locked deposit currencies (crypto)",
    hint: "Crypto currencies users in this country cannot use to deposit.",
    options: CRYPTO_OPTIONS,
  },
  locked_deposits_fiat: {
    label: "Locked deposit currencies (fiat)",
    hint: "Fiat/alternative deposit methods users in this country cannot use.",
    options: FIAT_OPTIONS,
  },
  locked_withdrawals_crypto: {
    label: "Locked withdrawal currencies (crypto)",
    hint: "Crypto currencies users in this country cannot use to withdraw.",
    options: CRYPTO_OPTIONS,
  },
};

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
  const boolValue: Record<Exclude<BooleanField, "blocked">, boolean> = {
    physical_withdrawal: row.physicalWithdrawal,
    digital_withdrawal: row.digitalWithdrawal,
    gift_card_deposit: row.giftCardDeposit,
    promo_code_deposit: row.promoCodeDeposit,
  };
  const arrayValue: Record<ArrayField, string[]> = {
    locked_deposits_crypto: row.lockedDepositsCrypto,
    locked_deposits_fiat: row.lockedDepositsFiat,
    locked_withdrawals_crypto: row.lockedWithdrawalsCrypto,
  };

  return (
    <div>
      <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(BOOL_HINTS) as (keyof typeof BOOL_HINTS)[]).map((field) => (
          <ToggleField
            key={field}
            label={BOOL_HINTS[field].label}
            hint={BOOL_HINTS[field].hint}
            polarity="allow"
            checked={boolValue[field]}
            disabled={isPending}
            onCheckedChange={() => onToggle(row.code, field, boolValue[field])}
          />
        ))}
      </div>
      <div className="grid gap-2 border-t p-4 sm:grid-cols-3">
        {(Object.keys(ARRAY_HINTS) as ArrayField[]).map((field) => (
          <CurrencyField
            key={field}
            label={ARRAY_HINTS[field].label}
            hint={ARRAY_HINTS[field].hint}
            values={arrayValue[field]}
            options={ARRAY_HINTS[field].options}
            disabled={isPending}
            onToggleValue={(optionValue) => {
              const current = arrayValue[field];
              const next = current.includes(optionValue)
                ? current.filter((v) => v !== optionValue)
                : [...current, optionValue];
              onArrayChange(row.code, field, current, next);
            }}
          />
        ))}
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
