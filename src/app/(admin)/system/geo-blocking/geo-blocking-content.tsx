"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import {
  Ban,
  ChevronRight,
  CreditCard,
  Globe,
  Layers,
  MapPin,
  Package,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import {
  reloadCountryRestrictionsCache,
  setGlobalFiatDeposits,
  setGlobalPhysicalItemWithdrawals,
  setMandatoryJurisdictionsGeoBlocked,
  toggleCountryRestriction,
  updateCountryRestrictionArray,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  RestrictionsTable,
  isRowRestricted,
  type ArrayField,
  type BooleanField,
  type RestrictionRowData,
} from "./restrictions-table";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";
import { isUsStateCode, usStateName } from "./us-states";
import {
  applyGlobalFiatPolicy,
  fiatJurisdictionName,
  FIAT_JURISDICTION_POLICY,
  hasAllWhopFiatDepositLocks,
  hasAnyWhopFiatDepositLock,
  isGlobalFiatPolicyActive,
  isMandatoryFiatJurisdiction,
  MANDATORY_FIAT_JURISDICTION_CODES,
  withWhopFiatDepositLocks,
} from "@/lib/fiat-jurisdiction-policy";

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
 *     each with its own KPI tile, so the handful of REAL restrictions are
 *     never buried in the bulk baseline.
 *   - 2026-07-27 (owner: "the filters like geo block, other restrictions or
 *     item withdrawal disabled should be like filter in a dropdown not a own
 *     tab"): the tab bar is gone. ONE table is now driven by two dropdowns
 *     next to the search box — Scope (Countries / US States / Fiat Policy)
 *     and Restriction (All / Geo-blocked / Other restrictions / Item
 *     withdrawal disabled / Fully open), each showing its live count. Same
 *     buckets and same rows as the tabs had, just selected instead of tabbed.
 *   - Raw ISO codes ("US", "DE") are resolved to readable country names
 *     (`i18n-iso-countries`) with a flag emoji derived from the alpha-2 code.
 *
 * Same server actions as before (`toggleCountryRestriction` /
 * `updateCountryRestrictionArray`); this file only reworks the client-side
 * presentation — see `./restrictions-table.tsx` for the shared per-row
 * expandable-detail table.
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
  const isState = isUsStateCode(c.countryCode);
  const policyName = fiatJurisdictionName(c.countryCode);
  const isUkraineRegion = c.countryCode.startsWith("UA-");
  return {
    code: c.countryCode,
    // US state rows (US-CA, …) aren't valid alpha-2, so resolve their name from
    // the state map instead of i18n-iso-countries (which returns undefined).
    name:
      policyName ??
      (isState
        ? usStateName(c.countryCode)
        : countries.getName(c.countryCode, "en") ?? c.countryCode),
    glyph: isState ? "🇺🇸" : isUkraineRegion ? "🇺🇦" : flagEmoji(c.countryCode),
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
function classifyRow(row: RestrictionRowData, ignoreFiatLock: boolean): RowBucket {
  if (row.blocked) return "blocked";
  // gift_card_deposit is intentionally omitted — the product has no gift cards, so that
  // flag is dead and must not affect bucketing (mirrors isRowRestricted in the table).
  // `ignoreFiatLock` does the same for the site-wide card-deposit lock while it is off
  // globally — see the note above isRowRestricted in ./restrictions-table.tsx.
  const onlyItemWithdrawalOff =
    !row.physicalWithdrawal &&
    row.digitalWithdrawal &&
    row.promoCodeDeposit &&
    row.lockedDepositsCrypto.length === 0 &&
    (ignoreFiatLock || row.lockedDepositsFiat.length === 0) &&
    row.lockedWithdrawalsCrypto.length === 0;
  if (onlyItemWithdrawalOff) return "itemWithdrawalOnly";
  if (isRowRestricted(row, ignoreFiatLock)) return "other";
  return "open";
}

type Scope = "countries" | "usStates" | "policy";
type RestrictionFilter = RowBucket | "all";

const SCOPE_LABELS: Record<Scope, string> = {
  countries: "Countries",
  usStates: "US States",
  policy: "Fiat Policy",
};

const RESTRICTION_LABELS: Record<RestrictionFilter, string> = {
  all: "All restrictions",
  blocked: "Geo-blocked",
  other: "Other restrictions",
  itemWithdrawalOnly: "Item withdrawal disabled",
  open: "Fully open",
};

const SCOPE_CODE_LABEL: Record<Scope, string> = {
  countries: "Country",
  usStates: "State",
  policy: "Jurisdiction",
};

export function GeoBlockingContent({
  countryRestrictions,
  siteLockedMethods,
}: {
  countryRestrictions: CountryRestrictionRow[];
  siteLockedMethods: string[] | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Local optimistic copy of the rows — see the "Scroll-fix" note above.
  const [rows, setRows] = useState(countryRestrictions);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<Scope>("countries");
  const [restriction, setRestriction] = useState<RestrictionFilter>("all");
  // In-flight country codes — see the "Per-row pending" note above.
  const [pendingCodes, setPendingCodes] = useState<Set<string>>(new Set());
  const [reloadingCache, setReloadingCache] = useState(false);
  const [globalFiatPending, setGlobalFiatPending] = useState(false);
  const [globalPhysicalPending, setGlobalPhysicalPending] = useState(false);
  const [policyGeoPending, setPolicyGeoPending] = useState(false);
  const [policyListOpen, setPolicyListOpen] = useState(false);
  const [currentSiteLockedMethods, setCurrentSiteLockedMethods] = useState(
    siteLockedMethods,
  );

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
        toast.success(
          `Reloaded the ${res.resolvedEnv.toUpperCase()} fiat/site and country-restriction caches`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reload cache");
    } finally {
      setReloadingCache(false);
    }
  }

  // Global card-deposit switch. Enabling opens non-policy rows while preserving
  // every mandatory exclusion; disabling locks every row. The server action
  // also moves the site-wide lock in the same transaction.
  function handleGlobalFiat(allowed: boolean) {
    const previous = rows;
    const previousSiteLocks = currentSiteLockedMethods;
    setRows((current) => applyGlobalFiatPolicy(current, allowed));
    setGlobalFiatPending(true);
    startTransition(async () => {
      try {
        const res = await setGlobalFiatDeposits(allowed);
        setCurrentSiteLockedMethods(res.lockedMethods);
        if (
          res.siteConfigCacheReloaded &&
          res.countryRestrictionsCacheReloaded
        ) {
          toast.success(
            allowed
              ? `Whop fiat enabled outside ${res.protected} required exclusions`
              : `Whop fiat disabled across ${res.affected} location entries`,
          );
        } else {
          toast.warning(
            "The database policy was saved, but the backend cache did not fully reload. Use Reload cache before treating the change as live.",
            { duration: 12000 },
          );
        }
        router.refresh();
      } catch (e) {
        setRows(previous);
        setCurrentSiteLockedMethods(previousSiteLocks);
        toast.error(
          e instanceof Error ? e.message : "Failed to update fiat deposits",
        );
      } finally {
        setGlobalFiatPending(false);
      }
    });
  }

  function handlePolicyGeoBlock(blocked: boolean) {
    const previous = rows;
    setRows((current) =>
      current.map((row) =>
        isMandatoryFiatJurisdiction(row.countryCode)
          ? { ...row, blocked }
          : row,
      ),
    );
    setPolicyGeoPending(true);
    startTransition(async () => {
      try {
        const res = await setMandatoryJurisdictionsGeoBlocked(blocked);
        if (res.countryRestrictionsCacheReloaded) {
          toast.success(
            `${blocked ? "Geo-blocked" : "Unblocked"} ${res.affected} policy jurisdictions`,
          );
        } else {
          toast.warning(
            "The geo-block policy was saved, but the backend cache did not reload. Use Reload cache before treating the change as live.",
            { duration: 12000 },
          );
        }
        router.refresh();
      } catch (error) {
        setRows(previous);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to update policy geo blocks",
        );
      } finally {
        setPolicyGeoPending(false);
      }
    });
  }

  function handleGlobalPhysicalItemWithdrawals(enabled: boolean) {
    const previous = rows;
    setRows((current) =>
      current.map((row) => ({ ...row, physicalWithdrawal: enabled })),
    );
    setGlobalPhysicalPending(true);
    startTransition(async () => {
      try {
        const res = await setGlobalPhysicalItemWithdrawals(enabled);
        if (res.countryRestrictionsCacheReloaded) {
          toast.success(
            enabled
              ? `Physical item withdrawals enabled across ${res.total} location entries`
              : `Physical item withdrawals disabled across ${res.total} location entries`,
          );
        } else {
          toast.warning(
            "The physical-withdrawal policy was saved, but the backend cache did not reload. Use Reload cache before treating the change as live.",
            { duration: 12000 },
          );
        }
        router.refresh();
      } catch (error) {
        setRows(previous);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to update physical item withdrawals",
        );
      } finally {
        setGlobalPhysicalPending(false);
      }
    });
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
    setCurrentSiteLockedMethods(siteLockedMethods);
  }, [countryRestrictions, isPending, siteLockedMethods]);

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
    const previousFiatLocks =
      rows.find((row) => row.countryCode === countryCode)
        ?.lockedDepositsFiat ?? [];
    patchRow(countryCode, prop, next);
    if (isMandatoryFiatJurisdiction(countryCode)) {
      patchRow(
        countryCode,
        "lockedDepositsFiat",
        withWhopFiatDepositLocks(previousFiatLocks),
      );
    }
    beginPending(countryCode);
    startTransition(async () => {
      try {
        await toggleCountryRestriction(countryCode, field, next);
        toast.success("Restriction updated");
      } catch (e) {
        patchRow(countryCode, prop, currentValue);
        if (isMandatoryFiatJurisdiction(countryCode)) {
          patchRow(countryCode, "lockedDepositsFiat", previousFiatLocks);
        }
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
  // Split US state rows (US-CA, …) out of the country list so they get their
  // OWN tab and don't pollute the country buckets/count. Both edit through the
  // exact same actions — a `US-CA` row toggles like any other country_code.
  const countryRows = useMemo(
    () => restrictionRows.filter((r) => !r.code.includes("-")),
    [restrictionRows],
  );
  const stateRows = useMemo(
    () => restrictionRows.filter((r) => isUsStateCode(r.code)),
    [restrictionRows],
  );
  const policyRows = useMemo(
    () =>
      MANDATORY_FIAT_JURISDICTION_CODES.map((code) =>
        restrictionRows.find((row) => row.code === code),
      ).filter((row): row is RestrictionRowData => row !== undefined),
    [restrictionRows],
  );
  const totalCount = countryRows.length;
  // Count states that are actually GEO-BLOCKED, not "has any flag set". The old
  // `isRowRestricted` count read 51/51 purely because the global card-deposit
  // lock is on every row (owner, 2026-07-27) — that is a site-wide payment
  // switch, not a geo restriction, and it already has its own panel above.
  const statesBlocked = useMemo(
    () => stateRows.filter((r) => r.blocked).length,
    [stateRows],
  );

  const fiatDisabledCount = useMemo(
    () =>
      restrictionRows.filter((row) =>
        hasAnyWhopFiatDepositLock(row.lockedDepositsFiat),
      ).length,
    [restrictionRows],
  );
  const physicalAllowedCount = rows.filter(
    (row) => row.physicalWithdrawal,
  ).length;
  const allPhysicalAllowed =
    rows.length > 0 && physicalAllowedCount === rows.length;
  const globalPhysicalCaption = allPhysicalAllowed
    ? `Enabled across all ${rows.length} location rows`
    : physicalAllowedCount === 0
      ? `Disabled across all ${rows.length} location rows`
      : `${physicalAllowedCount}/${rows.length} location rows enabled`;
  const allFiatAllowed =
    currentSiteLockedMethods !== null &&
    isGlobalFiatPolicyActive(currentSiteLockedMethods, rows);
  // Card deposits off site-wide ⇒ every row carries the fiat lock, so it is a
  // baseline, not a per-location restriction. See ./restrictions-table.tsx.
  const fiatLockIsBaseline = !allFiatAllowed;
  const policyFiatLocked = policyRows.filter((row) =>
    hasAllWhopFiatDepositLocks(row.lockedDepositsFiat),
  ).length;
  const policyGeoBlocked = policyRows.filter((row) => row.blocked).length;
  const allPolicyGeoBlocked =
    policyRows.length === MANDATORY_FIAT_JURISDICTION_CODES.length &&
    policyGeoBlocked === policyRows.length;
  const globalFiatCaption =
    currentSiteLockedMethods === null
      ? "Site lock configuration could not be loaded"
      : allFiatAllowed
        ? `Enabled globally with ${policyFiatLocked} required exclusions`
        : `${fiatDisabledCount} location rows currently lock card deposits`;

  const buckets = useMemo(() => {
    const blocked: RestrictionRowData[] = [];
    const itemWithdrawalOnly: RestrictionRowData[] = [];
    const other: RestrictionRowData[] = [];
    const open: RestrictionRowData[] = [];
    for (const row of countryRows) {
      switch (classifyRow(row, fiatLockIsBaseline)) {
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
  }, [countryRows, fiatLockIsBaseline]);

  // The scope dropdown picks WHICH row-set is on the table; the restriction
  // dropdown narrows it to one `classifyRow` bucket. Both counts are live.
  const scopeRows =
    scope === "usStates" ? stateRows : scope === "policy" ? policyRows : countryRows;

  const scopeCounts = useMemo(
    () => ({
      countries: countryRows.length,
      usStates: stateRows.length,
      policy: policyRows.length,
    }),
    [countryRows.length, stateRows.length, policyRows.length],
  );

  const restrictionCounts = useMemo(() => {
    const counts: Record<RestrictionFilter, number> = {
      all: scopeRows.length,
      blocked: 0,
      other: 0,
      itemWithdrawalOnly: 0,
      open: 0,
    };
    for (const row of scopeRows) counts[classifyRow(row, fiatLockIsBaseline)] += 1;
    return counts;
  }, [scopeRows, fiatLockIsBaseline]);

  const visibleRows = useMemo(() => {
    const byRestriction =
      restriction === "all"
        ? scopeRows
        : scopeRows.filter(
            (row) => classifyRow(row, fiatLockIsBaseline) === restriction,
          );
    return filterByTerm(byRestriction, search);
  }, [scopeRows, restriction, search, fiatLockIsBaseline]);

  const scopeNoun =
    scope === "usStates" ? "US states" : scope === "policy" ? "policy jurisdictions" : "countries";
  const emptyState = search
    ? {
        title: `No ${scopeNoun} match your search`,
        description:
          restriction === "all"
            ? undefined
            : 'Set the restriction filter to "All restrictions" to search everything.',
      }
    : restriction === "all"
      ? {
          title: `No ${scopeNoun} found`,
          description:
            scope === "policy"
              ? "Use the global card-deposit or policy geo-block switch to seed and enforce all required rows."
              : undefined,
        }
      : {
          title: `No ${scopeNoun} in "${RESTRICTION_LABELS[restriction]}"`,
          description: `Switch the restriction filter to "All restrictions" to see and edit every ${SCOPE_CODE_LABEL[scope].toLowerCase()}.`,
        };

  return (
    <div className="space-y-4">
      <SectionHeading icon={Globe} title="Geo Blocking" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
        <KpiTile
          label="US States Blocked"
          value={`${statesBlocked} / ${stateRows.length}`}
          icon={MapPin}
          accent="purple"
        />
      </div>

      {/* The three global switches sit side by side as compact control rows, and
          the policy jurisdiction list is collapsed by default (owner,
          2026-07-28: the policy panel was too big and too text-heavy). */}
      <div className="grid gap-3 lg:grid-cols-3">
        {/* Global fiat-deposit switch — flips locked_deposits_fiat for EVERY
            country + US state at once (bulk write). Optimistic; the per-row
            Fiat toggles in the tables reflect it immediately. */}
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <CreditCard className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm font-medium">Whop fiat deposits — global</div>
              <div className="truncate text-xs text-muted-foreground">
                {globalFiatCaption}
              </div>
            </div>
          </div>
          <Switch
            checked={allFiatAllowed}
            disabled={globalFiatPending || currentSiteLockedMethods === null}
            onCheckedChange={handleGlobalFiat}
          />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Package className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="text-sm font-medium">
                Physical item withdrawals — global
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {globalPhysicalCaption}
              </div>
            </div>
          </div>
          <Switch
            checked={allPhysicalAllowed}
            disabled={globalPhysicalPending || rows.length === 0}
            onCheckedChange={handleGlobalPhysicalItemWithdrawals}
            aria-label="Toggle physical item withdrawals globally"
          />
        </div>

        <div className="rounded-xl border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Ban className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  Geo-block policy jurisdictions
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {policyGeoBlocked}/{MANDATORY_FIAT_JURISDICTION_CODES.length}{" "}
                  blocked · fiat locks always on
                </div>
              </div>
            </div>
            <Switch
              checked={allPolicyGeoBlocked}
              disabled={policyGeoPending}
              onCheckedChange={handlePolicyGeoBlock}
            />
          </div>
          <Collapsible open={policyListOpen} onOpenChange={setPolicyListOpen}>
            <CollapsibleTrigger className="mt-2 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight
                className={`size-3.5 transition-transform ${policyListOpen ? "rotate-90" : ""}`}
              />
              {policyListOpen ? "Hide" : "Show"} jurisdiction list
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              {FIAT_JURISDICTION_POLICY.map((group) => (
                <div key={group.key}>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label} ({group.jurisdictions.length})
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {group.jurisdictions.map((item) => (
                      <span
                        key={item.code}
                        className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {item.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Search country or US state name / code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {/* Scope + restriction are dropdown filters over ONE table (owner,
              2026-07-27) — these used to be six separate tabs. */}
          <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
            <SelectTrigger className="h-9 w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SCOPE_LABELS) as Scope[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SCOPE_LABELS[key]} ({scopeCounts[key]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={restriction}
            onValueChange={(v) => setRestriction(v as RestrictionFilter)}
          >
            <SelectTrigger className="h-9 w-[230px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(RESTRICTION_LABELS) as RestrictionFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {RESTRICTION_LABELS[key]} ({restrictionCounts[key]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        </div>
      </div>

      <RestrictionsTable
        rows={visibleRows}
        codeLabel={SCOPE_CODE_LABEL[scope]}
        ignoreFiatLock={fiatLockIsBaseline}
        pendingCodes={pendingCodes}
        onToggle={handleToggle}
        onArrayChange={handleArrayChange}
        emptyState={emptyState}
      />
    </div>
  );
}
