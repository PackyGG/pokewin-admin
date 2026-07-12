"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { Ban, Globe, Search, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import {
  toggleCountryRestriction,
  updateCountryRestrictionArray,
} from "./actions";
import {
  RestrictionsTable,
  isRowRestricted,
  type ArrayField,
  type BooleanField,
  type RestrictionRowData,
} from "./restrictions-table";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";

countries.registerLocale(enLocale);

/**
 * Geo Blocking — relocated from the old `/settings` "Country Restrictions"
 * section into its own /system/geo-blocking page. Reworked 2026-07-12 for
 * usability (owner: "kinda bad overview and hard to use"):
 *
 *   - The flat 249-row / 9-column table gave every country equal visual
 *     weight, so the handful of actually-restricted countries were lost in
 *     a sea of fully-open rows. Now split into "Restricted" (default tab,
 *     shows what's ALREADY blocked at a glance) vs "All countries" (browse
 *     + search everything, e.g. to add a new restriction).
 *   - Raw ISO codes ("US", "DE") are resolved to readable country names
 *     (`i18n-iso-countries`, already a dependency — see
 *     creators/[userId]/country-breakdown.tsx for the existing precedent)
 *     with a flag emoji derived directly from the alpha-2 code (regional
 *     indicator symbols — no extra dependency).
 *   - A KPI strip surfaces the counts (Total / Restricted / Unrestricted)
 *     that used to require scrolling the whole table to eyeball.
 *   - The 9 flat columns collapsed to 3 (Country / Blocked / Restrictions)
 *     with the 4 finer-grained capability toggles + 3 locked-currency
 *     multi-selects moved into a per-row expandable detail — see
 *     `./restrictions-table.tsx` for that (now reusable) piece.
 *
 * Same server actions as before (`toggleCountryRestriction` /
 * `updateCountryRestrictionArray`); this file only reworks the client-side
 * presentation. The optimistic-update / no-router-refresh scroll-fix
 * documented below is unchanged from the prior version.
 *
 * Scroll-fix: every toggle / multi-select updates a LOCAL optimistic copy of
 * the rows in place and runs its action WITHOUT a router.refresh(). A full
 * refresh re-fetched every server component and dumped the admin at a random
 * scroll position on a page that can list hundreds of countries. The server
 * stays source of truth via each action's revalidatePath; the effect below
 * re-syncs the local rows to a genuine prop change unless a write is in
 * flight, and a failed action rolls the specific field back + toasts.
 */

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

// Regional-indicator flag emoji from an alpha-2 code — no extra dependency.
function flagEmoji(alpha2: string): string {
  if (!/^[A-Za-z]{2}$/.test(alpha2)) return "";
  return alpha2
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

function toRestrictionRow(c: CountryRestrictionRow): RestrictionRowData {
  return {
    code: c.countryCode,
    name: countries.getName(c.countryCode, "en") ?? c.countryCode,
    glyph: flagEmoji(c.countryCode),
    physicalWithdrawal: c.physicalWithdrawal,
    digitalWithdrawal: c.digitalWithdrawal,
    giftCardDeposit: c.giftCardDeposit,
    promoCodeDeposit: c.promoCodeDeposit,
    blocked: c.blocked,
    lockedDepositsCrypto: c.lockedDepositsCrypto,
    lockedDepositsFiat: c.lockedDepositsFiat,
    lockedWithdrawalsCrypto: c.lockedWithdrawalsCrypto,
  };
}

export function GeoBlockingContent({
  countryRestrictions,
}: {
  countryRestrictions: CountryRestrictionRow[];
}) {
  const [isPending, startTransition] = useTransition();
  // Local optimistic copy of the rows — see the "Scroll-fix" note above.
  const [rows, setRows] = useState(countryRestrictions);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"restricted" | "all">("restricted");

  useEffect(() => {
    if (isPending) return;
    setRows(countryRestrictions);
  }, [countryRestrictions, isPending]);

  function patchRow(
    countryCode: string,
    prop: keyof CountryRestrictionRow,
    value: boolean | string[],
  ) {
    const patch = { [prop]: value } as Partial<CountryRestrictionRow>;
    setRows((prev) =>
      prev.map((r) => (r.countryCode === countryCode ? { ...r, ...patch } : r)),
    );
  }

  function handleToggle(countryCode: string, field: BooleanField, currentValue: boolean) {
    const next = !currentValue;
    const prop = BOOL_PROP[field];
    patchRow(countryCode, prop, next);
    startTransition(async () => {
      try {
        await toggleCountryRestriction(countryCode, field, next);
        toast.success("Restriction updated");
      } catch (e) {
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
    patchRow(countryCode, prop, newValues);
    startTransition(async () => {
      try {
        await updateCountryRestrictionArray(countryCode, field, newValues);
        toast.success("Restriction updated");
      } catch (e) {
        patchRow(countryCode, prop, previousValues);
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  const restrictionRows = useMemo(() => rows.map(toRestrictionRow), [rows]);
  const totalCount = restrictionRows.length;
  const restrictedCount = useMemo(
    () => restrictionRows.filter(isRowRestricted).length,
    [restrictionRows],
  );
  const openCount = totalCount - restrictedCount;

  const searched = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return restrictionRows;
    return restrictionRows.filter(
      (r) => r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term),
    );
  }, [restrictionRows, search]);

  const restrictedRows = useMemo(() => searched.filter(isRowRestricted), [searched]);

  return (
    <div className="space-y-4">
      <SectionHeading icon={Globe} title="Geo Blocking" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile label="Countries" value={String(totalCount)} icon={Globe} accent="blue" />
        <KpiTile label="Restricted" value={String(restrictedCount)} icon={Ban} accent="rose" />
        <KpiTile label="Unrestricted" value={String(openCount)} icon={ShieldCheck} accent="emerald" />
      </div>

      <div className="relative w-full sm:max-w-sm">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          placeholder="Search by country name or code..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "restricted" | "all")}>
        <TabsList>
          <TabsTrigger value="restricted">Restricted ({restrictedRows.length})</TabsTrigger>
          <TabsTrigger value="all">All countries ({searched.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="restricted">
          <RestrictionsTable
            rows={restrictedRows}
            codeLabel="Country"
            isPending={isPending}
            onToggle={handleToggle}
            onArrayChange={handleArrayChange}
            emptyState={
              search
                ? {
                    title: "No restricted countries match your search",
                    description: "Try the All countries tab to search everything.",
                  }
                : {
                    title: "No countries are currently restricted",
                    description: "Every country is fully open. Switch to All countries to add a restriction.",
                  }
            }
          />
        </TabsContent>
        <TabsContent value="all">
          <RestrictionsTable
            rows={searched}
            codeLabel="Country"
            isPending={isPending}
            onToggle={handleToggle}
            onArrayChange={handleArrayChange}
            emptyState={{ title: "No countries match your search" }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
