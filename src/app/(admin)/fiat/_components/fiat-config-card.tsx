"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CreditCard, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ux";
import type { FiatConfigRow } from "@/lib/queries/fiat";
import type { CountryRestrictionRow } from "@/lib/queries/geo-blocking";
import {
  FIAT_JURISDICTION_POLICY,
  hasAllWhopFiatDepositLocks,
  isGlobalFiatPolicyActive,
  MANDATORY_FIAT_JURISDICTION_CODES,
} from "@/lib/fiat-jurisdiction-policy";
import { setGlobalFiatDeposits } from "../../system/geo-blocking/actions";
import { updateFiatConfigAction, type FiatEditableKey } from "../actions";

const METHOD_OPTIONS = [
  { value: "paypal", label: "PayPal" },
  { value: "paysafecard", label: "Paysafecard" },
  { value: "pulse", label: "Pulse" },
  { value: "bank_transfer", label: "Bank transfer" },
] as const;

function parseMethods(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function FiatConfigCard({
  rows,
  restrictions,
  canEdit,
}: {
  rows: FiatConfigRow[];
  restrictions: CountryRestrictionRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const byKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  const [cardMax, setCardMax] = useState(
    byKey.get("card_deposit_max_usd")?.value ?? "",
  );
  const [holdThreshold, setHoldThreshold] = useState(
    byKey.get("deposit_withdrawal_hold_threshold_usd")?.value ?? "",
  );
  const [lockedMethods, setLockedMethods] = useState<string[]>(() =>
    parseMethods(byKey.get("locked_deposits_fiat")?.value),
  );
  const [restrictionRows, setRestrictionRows] = useState(restrictions);
  const [isPending, startTransition] = useTransition();
  const [globalPending, setGlobalPending] = useState(false);
  const [globalCacheStale, setGlobalCacheStale] = useState(false);

  useEffect(() => {
    setCardMax(byKey.get("card_deposit_max_usd")?.value ?? "");
    setHoldThreshold(
      byKey.get("deposit_withdrawal_hold_threshold_usd")?.value ?? "",
    );
    setLockedMethods(
      parseMethods(byKey.get("locked_deposits_fiat")?.value),
    );
    setRestrictionRows(restrictions);
  }, [byKey, restrictions]);

  const editableRows = new Set([
    "card_deposit_max_usd",
    "deposit_withdrawal_hold_threshold_usd",
    "locked_deposits_fiat",
  ]);
  const referenceRows = rows.filter((row) => !editableRows.has(row.key));
  const siteLockConfigured = byKey.has("locked_deposits_fiat");
  const globalCardDepositsEnabled =
    siteLockConfigured &&
    isGlobalFiatPolicyActive(lockedMethods, restrictionRows);
  const rowsByCode = new Map(
    restrictionRows.map((row) => [row.countryCode, row]),
  );
  const policyRowsPresent = MANDATORY_FIAT_JURISDICTION_CODES.filter((code) =>
    rowsByCode.has(code),
  ).length;
  const policyRowsLocked = MANDATORY_FIAT_JURISDICTION_CODES.filter((code) =>
    hasAllWhopFiatDepositLocks(
      rowsByCode.get(code)?.lockedDepositsFiat ?? [],
    ),
  ).length;

  function handleGlobalCardDeposits(allowed: boolean) {
    const previousMethods = lockedMethods;
    setGlobalPending(true);
    startTransition(async () => {
      try {
        const result = await setGlobalFiatDeposits(allowed);
        setLockedMethods(result.lockedMethods);
        if (result.siteConfigCacheReloaded) {
          setGlobalCacheStale(false);
          toast.success(
            allowed
              ? "Whop fiat enabled globally"
              : "Whop fiat disabled site-wide",
          );
        } else {
          setGlobalCacheStale(true);
          toast.warning(
            "The global fiat gate was saved, but the backend cache did not reload. Open Geo Blocking and use Reload cache before treating the change as live.",
            { duration: 12000 },
          );
        }
        router.refresh();
      } catch (error) {
        setLockedMethods(previousMethods);
        console.error("[fiat-config] global availability update failed", error);
        toast.error("Global card-deposit update failed. Refresh and try again.");
      } finally {
        setGlobalPending(false);
      }
    });
  }

  function save(
    key: FiatEditableKey,
    value: number | string[],
    successMessage: string,
  ) {
    startTransition(async () => {
      try {
        const result = await updateFiatConfigAction({ key, value });
        if (key === "card_deposit_max_usd") setCardMax(result.value);
        if (key === "deposit_withdrawal_hold_threshold_usd") {
          setHoldThreshold(result.value);
        }
        if (key === "locked_deposits_fiat") {
          setLockedMethods(parseMethods(result.value));
        }
        toast.success(successMessage);
      } catch (error) {
        console.error("[fiat-config] setting update failed", error);
        toast.error("Fiat setting update failed. Check the value and try again.");
      }
    });
  }

  function numericSetting({
    key,
    title,
    description,
    value,
    onChange,
    suffix,
  }: {
    key: "card_deposit_max_usd" | "deposit_withdrawal_hold_threshold_usd";
    title: string;
    description: string;
    value: string;
    onChange: (value: string) => void;
    suffix: string;
  }) {
    const configured = byKey.has(key);
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {configured ? (
            <>
              <div className="flex items-center gap-2">
                <Input
                  aria-label={title}
                  type="number"
                  min={key === "card_deposit_max_usd" ? 1 : 0}
                  step="1"
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  disabled={!canEdit || isPending}
                  className="max-w-40 tabular-nums"
                />
                <span className="text-sm text-muted-foreground">{suffix}</span>
              </div>
              <Button
                size="sm"
                disabled={!canEdit || isPending || value.trim() === ""}
                onClick={() => save(key, Number(value), `${title} updated`)}
              >
                {isPending ? (
                  <Spinner size={14} />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save
              </Button>
            </>
          ) : (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Not configured in this environment. This page will not create a
              missing money-control key.
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {numericSetting({
          key: "card_deposit_max_usd",
          title: "Maximum card deposit",
          description:
            "Maximum Whop fiat amount accepted for one checkout. The backend enforces this before checkout creation.",
          value: cardMax,
          onChange: setCardMax,
          suffix: "USD per transaction",
        })}
        {numericSetting({
          key: "deposit_withdrawal_hold_threshold_usd",
          title: "Automatic withdrawal hold",
          description:
            "Lifetime completed deposit total that triggers the backend's withdrawal-only account hold.",
          value: holdThreshold,
          onChange: setHoldThreshold,
          suffix: "USD lifetime",
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <CreditCard className="size-4" />
            Global Whop fiat availability
          </CardTitle>
          <CardDescription>
            Controls the complete Whop checkout: card, Apple Pay, Google Pay,
            and eligible Cash App. Enabling opens it everywhere except the 33
            mandatory policy jurisdictions; disabling blocks the whole
            checkout site-wide.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {siteLockConfigured ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
                <div>
                  <div className="text-sm font-medium">
                    Accept Whop fiat deposits
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {globalCacheStale
                      ? "Saved, but backend cache activation is unconfirmed"
                      : globalCardDepositsEnabled
                      ? `Live globally; ${policyRowsLocked} policy jurisdictions stay locked`
                      : "Disabled or location policy is not fully applied"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {globalCardDepositsEnabled ? "Enabled" : "Disabled"}
                  </span>
                  <Switch
                    aria-label="Accept Whop fiat deposits"
                    checked={globalCardDepositsEnabled}
                    disabled={!canEdit || globalPending}
                    onCheckedChange={handleGlobalCardDeposits}
                  />
                </div>
              </div>

              {globalCacheStale && (
                <div
                  role="status"
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  The setting was saved, but the backend cache did not reload.
                  Use Geo Blocking → Reload cache before treating it as active.
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {FIAT_JURISDICTION_POLICY.map((group) => (
                  <div key={group.key} className="rounded-lg border p-3">
                    <div className="text-xs font-medium">{group.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {group.jurisdictions
                        .map((jurisdiction) => jurisdiction.name)
                        .join(", ")}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span>
                  Policy rows present: {policyRowsPresent} /{" "}
                  {MANDATORY_FIAT_JURISDICTION_CODES.length}. Whop-locked:{" "}
                  {policyRowsLocked} /{" "}
                  {MANDATORY_FIAT_JURISDICTION_CODES.length}.
                </span>
                <span>
                  Backend subdivision enforcement is live; this switch seeds
                  and locks all 33 policy rows.
                </span>
              </div>

              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <ShieldCheck className="size-3.5" />
                  Other legacy provider locks
                </div>
                <p className="text-xs text-muted-foreground">
                  Checked providers are site-locked. Card and Whop wallets are
                  controlled only by the global switch above so jurisdiction
                  exclusions cannot be bypassed.
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {METHOD_OPTIONS.map((method) => {
                  const checked = lockedMethods.includes(method.value);
                  return (
                    <div
                      key={method.value}
                      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                    >
                      <Label
                        htmlFor={`fiat-lock-${method.value}`}
                        className="text-xs font-medium"
                      >
                        {method.label}
                      </Label>
                      <Switch
                        id={`fiat-lock-${method.value}`}
                        checked={checked}
                        disabled={!canEdit || isPending}
                        onCheckedChange={(next) =>
                          setLockedMethods((current) =>
                            next
                              ? [...new Set([...current, method.value])]
                              : current.filter(
                                  (value) => value !== method.value,
                                ),
                          )
                        }
                      />
                    </div>
                  );
                })}
                </div>
              </div>
              <Button
                size="sm"
                disabled={!canEdit || isPending}
                onClick={() =>
                  save(
                    "locked_deposits_fiat",
                    lockedMethods,
                    "Fiat method locks updated",
                  )
                }
              >
                {isPending ? (
                  <Spinner size={14} />
                ) : (
                  <Save className="size-3.5" />
                )}
                Save legacy locks
              </Button>
            </div>
          ) : (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              The site-wide fiat lock list is not configured in this
              environment.
            </div>
          )}
        </CardContent>
      </Card>

      {referenceRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Related configuration</CardTitle>
            <CardDescription>
              Additional fiat-related keys discovered in this environment. They
              are shown for completeness and remain read-only here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {referenceRows.map((row) => (
              <div
                key={row.key}
                className="grid gap-1 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
              >
                <code className="break-all text-xs font-medium">{row.key}</code>
                <code className="break-all text-xs text-muted-foreground sm:text-right">
                  {row.value}
                </code>
                {row.description && (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    {row.description}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          Configuration is read-only for your account. Admin access plus the
          site-config capability is required to save changes.
        </p>
      )}
    </div>
  );
}
