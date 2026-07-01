"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { updateDepositBonusConfigAction } from "./deposit-bonus-config-actions";
import type { DepositBonusConfig } from "@/lib/backend-api/deposit-bonus-config";

/**
 * Affiliate deposit-bonus cap editor. The bonus is a fixed 5% of each deposit;
 * these two knobs bound how much of it a referred user can collect: at most
 * `cap_per_period_usd` within any trailing `period_hours` rolling window
 * (default $25 per 6h ≈ the legacy $100/24h, spread across the day).
 *
 * `initial === null` means the backend read failed (the deposit-bonus-config
 * endpoint isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable inputs rather than crashing /security.
 */

const MAX_PERIOD_HOURS = 720; // 30 days — matches the backend sanity cap
const MAX_CAP_USD = 100_000;

export function DepositBonusConfigCard({
  initial,
}: {
  initial: DepositBonusConfig | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved config after a successful write, so the card
  // reflects the saved value in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [baseline, setBaseline] = useState<DepositBonusConfig | null>(initial);

  // Form state as strings. Hooks must run unconditionally, so these are
  // declared even when initial is null (the degraded branch returns first).
  const [periodHours, setPeriodHours] = useState<string>(() =>
    initial ? String(initial.period_hours) : "",
  );
  const [capPerPeriod, setCapPerPeriod] = useState<string>(() =>
    initial ? String(initial.cap_per_period_usd) : "",
  );

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Deposit Bonus Cap
          </CardTitle>
          <CardDescription>
            Rolling window and max bonus a referred user can earn per window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The deposit-bonus-config endpoint isn&apos;t reachable on the
                current backend deploy. This card becomes editable once the
                feature ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Past the `!initial` guard above, initial is non-null; baseline is seeded
  // from it (and re-baselined on save), so this is the current server truth.
  const base = baseline ?? initial;

  const handleSave = () => {
    const periodRaw = periodHours.trim();
    const capRaw = capPerPeriod.trim();

    if (periodRaw === "" && capRaw === "") {
      toast.error("Enter at least one value");
      return;
    }

    const updates: { period_hours?: number; cap_per_period_usd?: number } = {};

    if (periodRaw !== "") {
      const period = Number(periodRaw);
      if (
        !Number.isFinite(period) ||
        period <= 0 ||
        period > MAX_PERIOD_HOURS
      ) {
        toast.error(
          `Period must be a number between 0 and ${MAX_PERIOD_HOURS} hours`,
        );
        return;
      }
      if (period !== base.period_hours) updates.period_hours = period;
    }

    if (capRaw !== "") {
      const cap = Number(capRaw);
      if (!Number.isFinite(cap) || cap < 0 || cap > MAX_CAP_USD) {
        toast.error(`Cap must be a number between 0 and ${MAX_CAP_USD}`);
        return;
      }
      if (cap !== base.cap_per_period_usd) updates.cap_per_period_usd = cap;
    }

    if (Object.keys(updates).length === 0) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateDepositBonusConfigAction(updates);
      if (result.success) {
        toast.success("Deposit bonus cap updated");
        // Re-baseline to the saved config in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating baseline just re-arms the dirty-check for the next edit.
        setBaseline(result.data);
      } else {
        toast.error(result.error);
      }
    });
  };

  const periodNum = periodHours.trim() === "" ? null : Number(periodHours);
  const capNum = capPerPeriod.trim() === "" ? null : Number(capPerPeriod);
  const dailyHint =
    periodNum !== null &&
    capNum !== null &&
    Number.isFinite(periodNum) &&
    Number.isFinite(capNum) &&
    periodNum > 0
      ? `≈ $${(capNum * (24 / periodNum)).toFixed(2)} max per 24h`
      : "≈ $— max per 24h";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Deposit Bonus Cap</CardTitle>
        <CardDescription>
          The affiliate deposit bonus is a fixed 5% of each deposit. These knobs
          cap it at a max USD amount within a rolling window (default $25 per
          6h). Saving writes through the backend, which validates and refreshes
          its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            The cap is enforced over the trailing window: a user can earn at
            most the cap amount in any span of that many hours. Lowering either
            value shrinks future bonuses immediately and never re-touches
            bonuses already credited.
          </p>
        </div>

        <div className="grid max-w-md gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="deposit-bonus-period">Period (hours)</Label>
            <Input
              id="deposit-bonus-period"
              type="number"
              step="1"
              min="1"
              max={MAX_PERIOD_HOURS}
              value={periodHours}
              onChange={(e) => setPeriodHours(e.target.value)}
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Rolling window length, e.g. <code>6</code>.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="deposit-bonus-cap">Max per period ($)</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {dailyHint}
              </span>
            </div>
            <Input
              id="deposit-bonus-cap"
              type="number"
              step="1"
              min="0"
              max={MAX_CAP_USD}
              value={capPerPeriod}
              onChange={(e) => setCapPerPeriod(e.target.value)}
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Max bonus USD per window, e.g. <code>25</code>.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={isPending}>
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
