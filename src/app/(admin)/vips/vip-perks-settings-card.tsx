"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  Loader2,
  ShieldCheck,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

import { updateVipPerksSettingsAction } from "./actions";

export type VipPerksSettingsView = {
  enabled: boolean;
  initialWagerWithoutCreatorCodeUsd: number;
  initialWagerWithCreatorCodeUsd: number;
  recurringEnabled: boolean;
  recurringWagerUsd: number | null;
};

const MAX_WAGER_USD = 100_000_000;

function parseWager(value: string, label: string): number | null {
  const wager = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(wager) ||
    wager <= 0 ||
    wager > MAX_WAGER_USD
  ) {
    toast.error(`${label} must be between $0.01 and $100,000,000`);
    return null;
  }
  return Math.round(wager * 100) / 100;
}

export function VipPerksSettingsCard({
  initial,
}: {
  initial: VipPerksSettingsView | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [initialWagerWithoutCode, setInitialWagerWithoutCode] = useState(
    initial ? String(initial.initialWagerWithoutCreatorCodeUsd) : "",
  );
  const [initialWagerWithCode, setInitialWagerWithCode] = useState(
    initial ? String(initial.initialWagerWithCreatorCodeUsd) : "",
  );
  const [recurringEnabled, setRecurringEnabled] = useState(
    initial?.recurringEnabled ?? false,
  );
  const [recurringWager, setRecurringWager] = useState(
    initial?.recurringWagerUsd == null ? "" : String(initial.recurringWagerUsd),
  );

  if (!initial) {
    return (
      <Card className="border-dashed border-amber-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-amber-500" aria-hidden />
            VIP perks access
          </CardTitle>
          <CardDescription>
            Global weighted-wager requirements and 30-day access windows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="font-semibold">Requirements unavailable</p>
              <p className="text-amber-700/80 dark:text-amber-300/80">
                The VIP perks service could not be reached. Settings stay
                read-only until a refresh loads the current server values.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  function handleSave() {
    const initialWagerWithoutCreatorCodeUsd = parseWager(
      initialWagerWithoutCode,
      "Standard initial requirement",
    );
    if (initialWagerWithoutCreatorCodeUsd === null) return;
    const initialWagerWithCreatorCodeUsd = parseWager(
      initialWagerWithCode,
      "Creator-code initial requirement",
    );
    if (initialWagerWithCreatorCodeUsd === null) return;

    const recurringWagerUsd = recurringEnabled
      ? parseWager(recurringWager, "Recurring requirement")
      : recurringWager.trim() === ""
        ? null
        : parseWager(recurringWager, "Recurring requirement");
    if (recurringEnabled && recurringWagerUsd === null) return;

    const next = {
      enabled,
      initialWagerWithoutCreatorCodeUsd,
      initialWagerWithCreatorCodeUsd,
      recurringEnabled,
      recurringWagerUsd,
    };
    if (
      saved &&
      next.enabled === saved.enabled &&
      next.initialWagerWithoutCreatorCodeUsd ===
        saved.initialWagerWithoutCreatorCodeUsd &&
      next.initialWagerWithCreatorCodeUsd ===
        saved.initialWagerWithCreatorCodeUsd &&
      next.recurringEnabled === saved.recurringEnabled &&
      next.recurringWagerUsd === saved.recurringWagerUsd
    ) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateVipPerksSettingsAction(next);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setSaved(result.data);
      setEnabled(result.data.enabled);
      setInitialWagerWithoutCode(
        String(result.data.initialWagerWithoutCreatorCodeUsd),
      );
      setInitialWagerWithCode(
        String(result.data.initialWagerWithCreatorCodeUsd),
      );
      setRecurringEnabled(result.data.recurringEnabled);
      setRecurringWager(
        result.data.recurringWagerUsd == null
          ? ""
          : String(result.data.recurringWagerUsd),
      );
      toast.success("VIP perk requirements updated");
    });
  }

  return (
    <Card className="overflow-hidden border-amber-500/20">
      <CardHeader className="border-b bg-gradient-to-r from-amber-500/10 via-card to-card">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-amber-500" aria-hidden />
              VIP perks access
            </CardTitle>
            <CardDescription className="max-w-2xl">
              Linking a player keeps their private channel and Packy account
              connected. Perks such as lossback activate only after they meet
              the weighted-wager requirement.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3 rounded-xl border bg-background/80 px-3 py-2 shadow-sm">
            <div className="text-right">
              <Label htmlFor="vip-perks-enabled" className="text-xs font-semibold">
                Perks system
              </Label>
              <p
                className={cn(
                  "text-[11px] font-medium",
                  enabled ? "text-emerald-500" : "text-muted-foreground",
                )}
              >
                {enabled ? "Enabled" : "Disabled globally"}
              </p>
            </div>
            <Switch
              id="vip-perks-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={isPending}
              aria-label="Enable VIP perks system"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        {!enabled && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Perk access is inactive globally. Linked channels and Packy
              accounts stay intact; the Discord perks role is removed during
              role sync.
            </p>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <RequirementPanel
            icon={BadgeCheck}
            eyebrow="First unlock · standard"
            title="Without a creator code"
            description="Lifetime cash-eligible weighted wager. The player must reach it within 30 days after their VIP channel is linked."
            inputId="vip-initial-wager-without-code"
            value={initialWagerWithoutCode}
            onChange={setInitialWagerWithoutCode}
            disabled={isPending}
          />

          <RequirementPanel
            icon={BadgeCheck}
            eyebrow="First unlock · creator"
            title="With an active creator code"
            description="The lower lifetime requirement applies only while the player has an active creator code, and is frozen when they unlock."
            inputId="vip-initial-wager-with-code"
            value={initialWagerWithCode}
            onChange={setInitialWagerWithCode}
            disabled={isPending}
          />

          <div
            className={cn(
              "rounded-xl border p-4 transition-colors",
              recurringEnabled
                ? "border-cyan-500/30 bg-cyan-500/[0.04]"
                : "bg-muted/20",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
                  <CalendarClock className="size-4" aria-hidden />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
                    Keep access
                  </p>
                  <h3 className="mt-0.5 text-sm font-semibold">
                    Recurring requirement
                  </h3>
                </div>
              </div>
              <Switch
                checked={recurringEnabled}
                onCheckedChange={setRecurringEnabled}
                disabled={isPending}
                aria-label="Enable recurring VIP perk requirement"
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              After the first unlock, players must reach this separate weighted
              wager during every following 30-day window.
            </p>
            <div className="mt-4 space-y-2">
              <Label htmlFor="vip-recurring-wager" className="text-xs">
                Weighted wager required (USD)
              </Label>
              <div className="relative max-w-sm">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="vip-recurring-wager"
                  type="number"
                  min="0.01"
                  max={MAX_WAGER_USD}
                  step="0.01"
                  value={recurringWager}
                  onChange={(event) => setRecurringWager(event.target.value)}
                  disabled={isPending || !recurringEnabled}
                  className="pl-7 tabular-nums"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarClock className="size-3.5" aria-hidden />
            Reward-funded wagers never count. Stored Keno and Upgrader weights
            do count. Initial access has a 30-day deadline; recurring access
            uses fixed 30-day cycles.
          </div>
          <Button onClick={handleSave} disabled={isPending} className="sm:min-w-36">
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {isPending ? "Saving…" : "Save requirements"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RequirementPanel({
  icon: Icon,
  eyebrow,
  title,
  description,
  inputId,
  value,
  onChange,
  disabled,
}: {
  icon: typeof BadgeCheck;
  eyebrow: string;
  title: string;
  description: string;
  inputId: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04] p-4">
      <div className="flex gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
          <Icon className="size-4" aria-hidden />
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            {eyebrow}
          </p>
          <h3 className="mt-0.5 text-sm font-semibold">{title}</h3>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="mt-4 space-y-2">
        <Label htmlFor={inputId} className="text-xs">
          Weighted wager required (USD)
        </Label>
        <div className="relative max-w-sm">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
            $
          </span>
          <Input
            id={inputId}
            type="number"
            min="0.01"
            max={MAX_WAGER_USD}
            step="0.01"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            className="pl-7 tabular-nums"
          />
        </div>
      </div>
    </div>
  );
}
