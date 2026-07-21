"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { Ban, CreditCard, Globe, Layers, Search, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { CollapsibleSection } from "./collapsible-section";
import {
  reloadCountryRestrictionsCache,
  seedMissingCountryRestrictions,
  toggleCountryRestriction,
  updateCountryRestrictionArray,
} from "./actions";
import { Button } from "@/components/ui/button";
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
 * usability, then reworked AGAIN 2026-07-21 (owner: "it shows restricted 250
 * but that is just item withdrawal but not geo blocked... whole ui is messy
 * and hard to use... bundled and collapsable"):
 *
 *   - The old single "Restricted" bucket lumped a TRUE geo-block
 *     (`blocked=true`, verified read-only: only 1 country) together with
 *     ~250 countries whose ONLY restriction is `physical_withdrawal=false`
 *     (item/card withdrawal off — a bulk baseline, not a curated geo-block)
 *     and a handful of other partial restrictions (digital withdrawal /
 *     gift card / promo code / locked currencies — verified: ~5 countries
 *     total). That conflation is exactly what made "Restricted: 250" read as
 *     "250 countries are geo-blocked" when only 1 actually is.
 *   - `classifyRow` below sorts every country into exactly ONE of four
 *     buckets (blocked / item-withdrawal-only / other-restricted / open),
 *     each with its own KPI tile + tab, so the handful of REAL restrictions
 *     are never buried in the bulk baseline.
 *   - The bulk "item withdrawal disabled" bucket is the one most likely to
 *     be huge (hundreds of countries all sharing the same non-curated
 *     default), so its tab renders as ONE collapsed summary card (bundled +
 *     collapsible per owner request) instead of dumping the full table —
 *     expand it only when you actually need to review/search that list.
 *   - Raw ISO codes ("US", "DE") are resolved to readable country names
 *     (`i18n-iso-countries`) with a flag emoji derived from the alpha-2 code.
 *
 * Same server actions as before (`toggleCountryRestriction` /
 * `updateCountryRestrictionArray`); this file only reworks the client-side
 * presentation — see `./restrictions-table.tsx` for the shared per-row
 * expandable-detail table these tabs all reuse.
 *
 * Scroll-fix / per-row pending: unchanged from the prior version — every
 * toggle / multi-select updates a LOCAL optimistic copy of the rows in place
 * and runs its action WITHOUT a router.refresh() (the server stays source of
 * truth via each action's revalidatePath); `pendingCodes` tracks in-flight
 * country codes individually so only the row being edited disables.
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

// Pure module-level filter (no component-scoped closure) so callers can
// memoize on `[list, search]` directly without an exhaustive-deps warning.
function filterByTerm(list: RestrictionRowData[], search: string): RestrictionRowData[] {
  const term = search.trim().toLowerCase();
  if (!term) return list;
  return list.filter(
    (r) => r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term),
  );
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

type RowBucket = "blocked" | "itemWithdrawalOnly" | "other" | "open";

/**
 * Sorts a row into exactly ONE bucket (see the file-header note). Priority
 * order matters: a genuinely geo-blocked country is "blocked" even if it
 * also happens to have item withdrawal off; "itemWithdrawalOnly" only fires
 * when NOTHING else is restricted alongside it.
 */
function classifyRow(row: RestrictionRowData): RowBucket {
  if (row.blocked) return "blocked";
  // gift_card_deposit is intentionally omitted — the product has no gift cards, so that
  // flag is dead and must not affect bucketing (mirrors isRowRestricted in the table).
  const onlyItemWithdrawalOff =
    !row.physicalWithdrawal &&
    row.digitalWithdrawal &&
    row.promoCodeDeposit &&
    row.lockedDepositsCrypto.length === 0 &&
    row.lockedDepositsFiat.length === 0 &&
    row.lockedWithdrawalsCrypto.length === 0;
  if (onlyItemWithdrawalOff) return "itemWithdrawalOnly";
  if (isRowRestricted(row)) return "other";
  return "open";
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
  const [tab, setTab] = useState<"blocked" | "other" | "itemWithdrawal" | "all">("blocked");
  const [itemWithdrawalOpen, setItemWithdrawalOpen] = useState(false);
  // In-flight country codes — see the "Per-row pending" note above.
  const [pendingCodes, setPendingCodes] = useState<Set<string>>(new Set());
  const [seeding, setSeeding] = useState(false);
  const [reloadingCache, setReloadingCache] = useState(false);

  async function handleReloadCache() {
    setReloadingCache(true);
    try {
      const res = await reloadCountryRestrictionsCache();
      if (res.requestedEnv !== res.resolvedEnv) {
        const want = res.requestedEnv.toUpperCase();
        toast.warning(
          `Busted the ${res.resolvedEnv.toUpperCase()} cache, but you're in ${want} mode — the ${want} backend isn't configured, so the ${want} cache was NOT reloaded. Set BACKEND_API_URL_${want} + BACKEND_ADMIN_KEY_${want}.`,
          { duration: 12000 },
        );
      } else {
        toast.success(`Reloaded the ${res.resolvedEnv.toUpperCase()} country-restriction cache`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reload cache");
    } finally {
      setReloadingCache(false);
    }
  }

  async function handleSeed() {
    setSeeding(true);
    try {
      const res = await seedMissingCountryRestrictions();
      toast.success(
        res.seeded === 0
          ? `All ${res.total} countries already present`
          : `Seeded ${res.seeded} missing ${res.seeded === 1 ? "country" : "countries"} (${res.total} total)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to seed countries");
    } finally {
      setSeeding(false);
    }
  }

  function beginPending(countryCode: string) {
    setPendingCodes((prev) => new Set(prev).add(countryCode));
  }
  function endPending(countryCode: string) {
    setPendingCodes((prev) => {
      if (!prev.has(countryCode)) return prev;
      const next = new Set(prev);
      next.delete(countryCode);
      return next;
    });
  }

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
    beginPending(countryCode);
    startTransition(async () => {
      try {
        await toggleCountryRestriction(countryCode, field, next);
        toast.success("Restriction updated");
      } catch (e) {
        patchRow(countryCode, prop, currentValue);
        toast.error(e instanceof Error ? e.message : "Failed");
      } finally {
        endPending(countryCode);
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
    beginPending(countryCode);
    startTransition(async () => {
      try {
        await updateCountryRestrictionArray(countryCode, field, newValues);
        toast.success("Restriction updated");
      } catch (e) {
        patchRow(countryCode, prop, previousValues);
        toast.error(e instanceof Error ? e.message : "Failed");
      } finally {
        endPending(countryCode);
      }
    });
  }

  const restrictionRows = useMemo(() => rows.map(toRestrictionRow), [rows]);
  const totalCount = restrictionRows.length;

  const buckets = useMemo(() => {
    const blocked: RestrictionRowData[] = [];
    const itemWithdrawalOnly: RestrictionRowData[] = [];
    const other: RestrictionRowData[] = [];
    const open: RestrictionRowData[] = [];
    for (const row of restrictionRows) {
      switch (classifyRow(row)) {
        case "blocked":
          blocked.push(row);
          break;
        case "itemWithdrawalOnly":
          itemWithdrawalOnly.push(row);
          break;
        case "other":
          other.push(row);
          break;
        default:
          open.push(row);
      }
    }
    return { blocked, itemWithdrawalOnly, other, open };
  }, [restrictionRows]);

  const searched = useMemo(
    () => filterByTerm(restrictionRows, search),
    [restrictionRows, search],
  );

  const blockedRows = useMemo(
    () => filterByTerm(buckets.blocked, search),
    [buckets.blocked, search],
  );
  const otherRows = useMemo(
    () => filterByTerm(buckets.other, search),
    [buckets.other, search],
  );
  const itemWithdrawalRows = useMemo(
    () => filterByTerm(buckets.itemWithdrawalOnly, search),
    [buckets.itemWithdrawalOnly, search],
  );

  return (
    <div className="space-y-4">
      <SectionHeading icon={Globe} title="Geo Blocking" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="Countries" value={String(totalCount)} icon={Globe} accent="blue" />
        <KpiTile
          label="Geo-Blocked"
          value={String(buckets.blocked.length)}
          icon={Ban}
          accent="rose"
        />
        <KpiTile
          label="Other Restrictions"
          value={String(buckets.other.length)}
          icon={Layers}
          accent="amber"
        />
        <KpiTile
          label="Item Withdrawal Disabled"
          value={String(buckets.itemWithdrawalOnly.length)}
          icon={CreditCard}
          accent="orange"
        />
        <KpiTile
          label="Fully Open"
          value={String(buckets.open.length)}
          icon={ShieldCheck}
          accent="emerald"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by country name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* Force the game backend to reload its country-restriction Redis
              cache now (it otherwise self-expires on a ~1h TTL). Reports which
              backend env (prod/dev) was actually busted, so a dev reload that
              silently falls back to prod is visible instead of looking done. */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleReloadCache}
            disabled={reloadingCache}
            title="Force the game backend to reload its country-restriction cache now instead of waiting for the ~1h TTL. Reports which env (prod/dev) was reloaded."
          >
            {reloadingCache ? "Reloading…" : "Reload cache"}
          </Button>
          {/* One-time backfill: add a row for every ISO country missing one (item withdrawal
              off baseline) so all countries are present + editable. Idempotent — safe to
              re-run; writes the prod game DB. */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSeed}
            disabled={seeding}
            title="Add a country_restrictions row for every ISO country missing one (item/physical withdrawal off), so every country is editable here."
          >
            {seeding ? "Seeding…" : "Seed missing countries"}
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "blocked" | "other" | "itemWithdrawal" | "all")}
      >
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="blocked">Geo-Blocked ({blockedRows.length})</TabsTrigger>
          <TabsTrigger value="other">Other Restrictions ({otherRows.length})</TabsTrigger>
          <TabsTrigger value="itemWithdrawal">
            Item Withdrawal Disabled ({itemWithdrawalRows.length})
          </TabsTrigger>
          <TabsTrigger value="all">All Countries ({searched.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="blocked">
          <RestrictionsTable
            rows={blockedRows}
            codeLabel="Country"
            pendingCodes={pendingCodes}
            onToggle={handleToggle}
            onArrayChange={handleArrayChange}
            emptyState={
              search
                ? {
                    title: "No geo-blocked countries match your search",
                    description: "Try the All Countries tab to search everything.",
                  }
                : {
                    title: "No countries are geo-blocked",
                    description: "Switch to All Countries to block one.",
                  }
            }
          />
        </TabsContent>

        <TabsContent value="other">
          <RestrictionsTable
            rows={otherRows}
            codeLabel="Country"
            pendingCodes={pendingCodes}
            onToggle={handleToggle}
            onArrayChange={handleArrayChange}
            emptyState={
              search
                ? {
                    title: "No countries match your search",
                    description: "Try the All Countries tab to search everything.",
                  }
                : {
                    title: "No other partial restrictions",
                    description:
                      "No country has a digital-withdrawal / gift-card / promo-code / locked-currency restriction beyond the item-withdrawal baseline.",
                  }
            }
          />
        </TabsContent>

        <TabsContent value="itemWithdrawal">
          {/* Bundled + collapsed by default (owner request) — hundreds of
              countries can share this exact restriction, so it stays folded
              into one summary line until an admin actually needs to search
              or edit that list. */}
          <CollapsibleSection
            icon={CreditCard}
            title={`${itemWithdrawalRows.length} countries — item/physical withdrawal disabled`}
            subtitle="Bulk baseline restriction, not a curated geo-block. Expand to search or edit."
            open={itemWithdrawalOpen}
            onOpenChange={setItemWithdrawalOpen}
          >
            <RestrictionsTable
              rows={itemWithdrawalRows}
              codeLabel="Country"
              pendingCodes={pendingCodes}
              onToggle={handleToggle}
              onArrayChange={handleArrayChange}
              emptyState={{
                title: "No countries match your search",
                description: "Try the All Countries tab to search everything.",
              }}
            />
          </CollapsibleSection>
        </TabsContent>

        <TabsContent value="all">
          <RestrictionsTable
            rows={searched}
            codeLabel="Country"
            pendingCodes={pendingCodes}
            onToggle={handleToggle}
            onArrayChange={handleArrayChange}
            emptyState={{ title: "No countries match your search" }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
