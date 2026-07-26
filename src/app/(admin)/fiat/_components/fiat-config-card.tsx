"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Save, ShieldCheck } from "lucide-react";
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
import { updateFiatConfigAction, type FiatEditableKey } from "../actions";

const METHOD_OPTIONS = [
  { value: "credit_card", label: "Credit card" },
  { value: "paypal", label: "PayPal" },
  { value: "paysafecard", label: "Paysafecard" },
  { value: "pulse", label: "Pulse" },
  { value: "apple_pay", label: "Apple Pay" },
  { value: "google_pay", label: "Google Pay" },
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
  canEdit,
}: {
  rows: FiatConfigRow[];
  canEdit: boolean;
}) {
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
  const [isPending, startTransition] = useTransition();

  const editableRows = new Set([
    "card_deposit_max_usd",
    "deposit_withdrawal_hold_threshold_usd",
    "locked_deposits_fiat",
  ]);
  const referenceRows = rows.filter((row) => !editableRows.has(row.key));

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
        toast.error(
          error instanceof Error ? error.message : "Fiat setting update failed",
        );
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
            <ShieldCheck className="size-4" />
            Site-wide fiat methods
          </CardTitle>
          <CardDescription>
            A checked method is locked. Credit card is the live Whop method;
            legacy methods remain visible because the backend still recognizes
            their lock tokens.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {byKey.has("locked_deposits_fiat") ? (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
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
                Save method locks
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
