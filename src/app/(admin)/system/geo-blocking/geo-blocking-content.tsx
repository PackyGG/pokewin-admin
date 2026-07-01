"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
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
  toggleCountryRestriction,
  updateCountryRestrictionArray,
} from "./actions";
import { ChevronDown, Globe } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SectionHeading } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

/**
 * Geo Blocking — relocated from the old `/settings` "Country Restrictions"
 * section into its own /system/geo-blocking page. Same per-country toggles
 * + three currency multi-selects, driven by the relocated server actions
 * (`toggleCountryRestriction` / `updateCountryRestrictionArray`) whose admin
 * guards/capabilities are unchanged. Only the labels were renamed from
 * "Country Restrictions" to "Geo Blocking".
 *
 * Scroll-fix: every toggle / multi-select updates a LOCAL optimistic copy of
 * the rows in place and runs its action WITHOUT a router.refresh(). A full
 * refresh re-fetched every server component and dumped the admin at a random
 * scroll position on a page that can list hundreds of countries. The server
 * stays source of truth via each action's revalidatePath; the effect below
 * re-syncs the local rows to a genuine prop change unless a write is in
 * flight, and a failed action rolls the specific field back + toasts.
 */

// The two toggle-able boolean fields (5 of them) and the three array fields
// this UI edits. Kept as string keys so the same handler serves every column.
type BooleanField =
  | "physical_withdrawal"
  | "digital_withdrawal"
  | "gift_card_deposit"
  | "promo_code_deposit"
  | "blocked";

type ArrayField =
  | "locked_deposits_crypto"
  | "locked_deposits_fiat"
  | "locked_withdrawals_crypto";

// Map a boolean field key → the camelCase property on CountryRestrictionRow.
const BOOL_PROP: Record<BooleanField, keyof CountryRestrictionRow> = {
  physical_withdrawal: "physicalWithdrawal",
  digital_withdrawal: "digitalWithdrawal",
  gift_card_deposit: "giftCardDeposit",
  promo_code_deposit: "promoCodeDeposit",
  blocked: "blocked",
};

const ARRAY_PROP: Record<ArrayField, keyof CountryRestrictionRow> = {
  locked_deposits_crypto: "lockedDepositsCrypto",
  locked_deposits_fiat: "lockedDepositsFiat",
  locked_withdrawals_crypto: "lockedWithdrawalsCrypto",
};

export function GeoBlockingContent({
  countryRestrictions,
}: {
  countryRestrictions: CountryRestrictionRow[];
}) {
  const [isPending, startTransition] = useTransition();
  // Local optimistic copy of the rows. Seeded from the server prop and kept
  // in sync with genuine revalidations (see the effect), but flipped instantly
  // on each toggle / multi-select so the control updates in place with no
  // full-route refresh.
  const [rows, setRows] = useState(countryRestrictions);

  // Re-sync to the server-truth prop when a real revalidation streams new rows
  // in — never while a write is mid-flight, so the stale pre-mutation prop
  // can't clobber the optimistic value we just set.
  useEffect(() => {
    if (isPending) return;
    setRows(countryRestrictions);
  }, [countryRestrictions, isPending]);

  function patchRow(
    countryCode: string,
    prop: keyof CountryRestrictionRow,
    value: boolean | string[],
  ) {
    // Each caller pairs a boolean prop with a boolean value and an array prop
    // with a string[] value (see BOOL_PROP / ARRAY_PROP), so the merge is
    // sound at runtime; the single-key partial keeps the assignment typed.
    const patch = { [prop]: value } as Partial<CountryRestrictionRow>;
    setRows((prev) =>
      prev.map((r) =>
        r.countryCode === countryCode ? { ...r, ...patch } : r,
      ),
    );
  }

  function handleCountryToggle(
    countryCode: string,
    field: BooleanField,
    currentValue: boolean,
  ) {
    const next = !currentValue;
    const prop = BOOL_PROP[field];
    // Optimistic flip — instant, no reload.
    patchRow(countryCode, prop, next);
    startTransition(async () => {
      try {
        await toggleCountryRestriction(countryCode, field, next);
        toast.success("Restriction updated");
      } catch (e) {
        // Roll the field back to its previous value.
        patchRow(countryCode, prop, currentValue);
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleArrayChange(
    countryCode: string,
    field: ArrayField,
    previousValues: string[],
    newValues: string[],
  ) {
    const prop = ARRAY_PROP[field];
    // Optimistic update — instant, no reload.
    patchRow(countryCode, prop, newValues);
    startTransition(async () => {
      try {
        await updateCountryRestrictionArray(countryCode, field, newValues);
        toast.success("Restriction updated");
      } catch (e) {
        // Roll the field back to its previous values.
        patchRow(countryCode, prop, previousValues);
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-3">
      <SectionHeading icon={Globe} title="Geo Blocking" />

      {rows.length === 0 ? (
        <div className="rounded-xl border">
          <EmptyState
            icon={Globe}
            title="No geo blocking rules configured"
            description="Every country is unrestricted until a row is added."
            compact
          />
        </div>
      ) : (
        <>
          {/* Desktop table (>=md). The 9-column grid overflows badly on
              phones, so it stays behind a horizontal-scroll guard here and
              is replaced by a stacked card list below md. */}
          <div className="hidden rounded-xl border overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead>Physical</TableHead>
                  <TableHead>Digital</TableHead>
                  <TableHead>Gift Card</TableHead>
                  <TableHead>Promo Code</TableHead>
                  <TableHead>Blocked</TableHead>
                  <TableHead>Locked Deposits Crypto</TableHead>
                  <TableHead>Locked Deposits Fiat</TableHead>
                  <TableHead>Locked Withdrawals Crypto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.countryCode}>
                    <TableCell className="font-medium">{c.countryCode}</TableCell>
                    <TableCell>
                      <Switch
                        checked={c.physicalWithdrawal}
                        onCheckedChange={() => handleCountryToggle(c.countryCode, "physical_withdrawal", c.physicalWithdrawal)}
                        disabled={isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.digitalWithdrawal}
                        onCheckedChange={() => handleCountryToggle(c.countryCode, "digital_withdrawal", c.digitalWithdrawal)}
                        disabled={isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.giftCardDeposit}
                        onCheckedChange={() => handleCountryToggle(c.countryCode, "gift_card_deposit", c.giftCardDeposit)}
                        disabled={isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.promoCodeDeposit}
                        onCheckedChange={() => handleCountryToggle(c.countryCode, "promo_code_deposit", c.promoCodeDeposit)}
                        disabled={isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.blocked}
                        onCheckedChange={() => handleCountryToggle(c.countryCode, "blocked", c.blocked)}
                        disabled={isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <CurrencyMultiSelect
                        countryCode={c.countryCode}
                        field="locked_deposits_crypto"
                        values={c.lockedDepositsCrypto}
                        options={CRYPTO_OPTIONS}
                        disabled={isPending}
                        onChange={handleArrayChange}
                      />
                    </TableCell>
                    <TableCell>
                      <CurrencyMultiSelect
                        countryCode={c.countryCode}
                        field="locked_deposits_fiat"
                        values={c.lockedDepositsFiat}
                        options={FIAT_OPTIONS}
                        disabled={isPending}
                        onChange={handleArrayChange}
                      />
                    </TableCell>
                    <TableCell>
                      <CurrencyMultiSelect
                        countryCode={c.countryCode}
                        field="locked_withdrawals_crypto"
                        values={c.lockedWithdrawalsCrypto}
                        options={CRYPTO_OPTIONS}
                        disabled={isPending}
                        onChange={handleArrayChange}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile card list (<md) — the 9-col table is unusable at 360px,
              so each country renders as a stacked card mirroring the
              admin-users mobile fallback: header + grouped toggle rows +
              the three currency multi-selects. */}
          <div className="space-y-2 md:hidden">
            {rows.map((c) => (
              <div
                key={c.countryCode}
                className="rounded-xl border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">{c.countryCode}</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(
                    [
                      ["Physical", "physical_withdrawal", c.physicalWithdrawal],
                      ["Digital", "digital_withdrawal", c.digitalWithdrawal],
                      ["Gift Card", "gift_card_deposit", c.giftCardDeposit],
                      ["Promo Code", "promo_code_deposit", c.promoCodeDeposit],
                      ["Blocked", "blocked", c.blocked],
                    ] as const
                  ).map(([label, field, value]) => (
                    <div
                      key={field}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2"
                    >
                      <span className="text-sm text-muted-foreground">
                        {label}
                      </span>
                      <Switch
                        checked={value}
                        onCheckedChange={() =>
                          handleCountryToggle(c.countryCode, field, value)
                        }
                        disabled={isPending}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {(
                    [
                      [
                        "Locked Deposits Crypto",
                        "locked_deposits_crypto",
                        c.lockedDepositsCrypto,
                        CRYPTO_OPTIONS,
                      ],
                      [
                        "Locked Deposits Fiat",
                        "locked_deposits_fiat",
                        c.lockedDepositsFiat,
                        FIAT_OPTIONS,
                      ],
                      [
                        "Locked Withdrawals Crypto",
                        "locked_withdrawals_crypto",
                        c.lockedWithdrawalsCrypto,
                        CRYPTO_OPTIONS,
                      ],
                    ] as const
                  ).map(([label, field, values, options]) => (
                    <div
                      key={field}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-sm text-muted-foreground">
                        {label}
                      </span>
                      <CurrencyMultiSelect
                        countryCode={c.countryCode}
                        field={field}
                        values={values}
                        options={options}
                        disabled={isPending}
                        onChange={handleArrayChange}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const CRYPTO_OPTIONS = [
  { value: "bitcoin", label: "Bitcoin" },
  { value: "ethereum", label: "Ethereum" },
  { value: "solana", label: "Solana" },
  { value: "usdt_erc20", label: "USDT (ERC20)" },
  { value: "usdt_trc20", label: "USDT (TRC20)" },
];

const FIAT_OPTIONS = [
  { value: "gift_card", label: "Gift Card" },
  { value: "promo_code", label: "Promo Code" },
];

function CurrencyMultiSelect({
  countryCode,
  field,
  values,
  options,
  disabled,
  onChange,
}: {
  countryCode: string;
  field: ArrayField;
  values: string[];
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (
    countryCode: string,
    field: ArrayField,
    previousValues: string[],
    newValues: string[],
  ) => void;
}) {
  function handleToggle(optionValue: string) {
    const newValues = values.includes(optionValue)
      ? values.filter((v) => v !== optionValue)
      : [...values, optionValue];
    onChange(countryCode, field, values, newValues);
  }

  return (
    <Popover>
      <PopoverTrigger disabled={disabled} className="flex items-center gap-1 text-xs cursor-pointer rounded border px-2 py-1 hover:bg-muted">
        {values.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <span>{values.length} blocked</span>
        )}
        <ChevronDown className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-2">
        <div className="flex flex-col gap-1">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={values.includes(opt.value)}
                onChange={() => handleToggle(opt.value)}
                disabled={disabled}
                className="rounded"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
