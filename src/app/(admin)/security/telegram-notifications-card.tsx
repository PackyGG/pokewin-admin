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
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import { updateTelegramNotificationsAction } from "./telegram-notifications-actions";
import type { TelegramNotificationSettings } from "@/lib/backend-api/telegram-notifications";

/**
 * Telegram admin-notification settings editor.
 *
 * A master switch, a per-notification on/off toggle for every alert the
 * backend can send, and the minimum deposit USD that triggers a "deposit
 * confirmed" alert. Everything applies on the backend's next notification —
 * it reads these per-call, so there's no restart or redeploy.
 *
 * `initial === null` means the backend read failed (the telegram-notifications
 * endpoint isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable controls rather than crashing /security.
 */

const MAX_DEPOSIT_MIN_USD = 100_000;

/** Per-notification toggles, in the order they're shown. */
const TOGGLES = [
  {
    field: "depositConfirmed",
    label: "Deposit confirmed",
    hint: "Crypto and fiat. Respects the minimum below.",
  },
  {
    field: "depositFailed",
    label: "Deposit failed",
    hint: "Crypto and fiat.",
  },
  {
    field: "withdrawalRequested",
    label: "Withdrawal requested",
    hint: "Crypto and balance withdrawals.",
  },
  {
    field: "withdrawalCompleted",
    label: "Withdrawal completed",
    hint: "Crypto and balance withdrawals.",
  },
  {
    field: "withdrawalFailed",
    label: "Withdrawal failed",
    hint: "Crypto and balance withdrawals.",
  },
  {
    field: "signupNotificationsEnabled",
    label: "New signup",
    hint: "One alert per new user registration.",
  },
] as const satisfies readonly {
  field: keyof TelegramNotificationSettings;
  label: string;
  hint: string;
}[];

type ToggleField = (typeof TOGGLES)[number]["field"];

export function TelegramNotificationsCard({
  initial,
}: {
  initial: TelegramNotificationSettings | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved settings after a successful write, so the card
  // reflects the saved value in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [baseline, setBaseline] = useState<TelegramNotificationSettings | null>(
    initial,
  );

  // Form state. Hooks must run unconditionally, so these are declared even
  // when initial is null (the degraded branch returns first).
  const [depositMin, setDepositMin] = useState<string>(() =>
    initial ? String(initial.depositMinUsd) : "",
  );
  const [master, setMaster] = useState<boolean>(
    () => initial?.masterEnabled ?? true,
  );
  const [toggles, setToggles] = useState<Record<ToggleField, boolean>>(() => ({
    depositConfirmed: initial?.depositConfirmed ?? true,
    depositFailed: initial?.depositFailed ?? true,
    withdrawalRequested: initial?.withdrawalRequested ?? true,
    withdrawalCompleted: initial?.withdrawalCompleted ?? true,
    withdrawalFailed: initial?.withdrawalFailed ?? true,
    signupNotificationsEnabled: initial?.signupNotificationsEnabled ?? true,
  }));

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Telegram Notifications
          </CardTitle>
          <CardDescription>
            Which alerts the backend posts to the admin chat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The telegram-notifications endpoint isn&apos;t reachable on the
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

  const setToggle = (field: ToggleField, next: boolean) =>
    setToggles((prev) => ({ ...prev, [field]: next }));

  const handleSave = () => {
    const updates: Record<string, number | boolean> = {};

    const minRaw = depositMin.trim();
    if (minRaw !== "") {
      const min = Number(minRaw);
      if (!Number.isFinite(min) || min < 0 || min > MAX_DEPOSIT_MIN_USD) {
        toast.error(
          `Minimum must be a number between 0 and ${MAX_DEPOSIT_MIN_USD}`,
        );
        return;
      }
      if (min !== base.depositMinUsd) updates.depositMinUsd = min;
    }

    if (master !== base.masterEnabled) updates.masterEnabled = master;

    for (const { field } of TOGGLES) {
      if (toggles[field] !== base[field]) updates[field] = toggles[field];
    }

    if (Object.keys(updates).length === 0) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateTelegramNotificationsAction(updates);
      if (result.success) {
        toast.success("Telegram notification settings updated");
        // Re-baseline to the saved settings in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating baseline just re-arms the dirty-check for the next edit.
        setBaseline(result.data);
      } else {
        toast.error(result.error);
      }
    });
  };

  const minNum = depositMin.trim() === "" ? null : Number(depositMin);
  const thresholdHint =
    minNum !== null && Number.isFinite(minNum) && minNum > 0
      ? `Deposits under $${minNum} stay silent`
      : "Every deposit alerts";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Telegram Notifications
        </CardTitle>
        <CardDescription>
          Which alerts the backend posts to the admin chat. Saving writes
          through the backend, which validates and refreshes its own cache —
          changes apply to the next notification, no restart needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Master switch — visually separated because it overrides everything */}
        <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-muted/30 p-3">
          <div className="space-y-0.5">
            <Label htmlFor="telegram-master" className="text-sm font-medium">
              All Telegram notifications
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Master switch. When off, nothing is sent — whatever the toggles
              below say.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="text-sm text-muted-foreground">
              {master ? "On" : "Off"}
            </span>
            <Switch
              id="telegram-master"
              checked={master}
              onCheckedChange={setMaster}
              disabled={isPending}
              aria-label={
                master
                  ? "Disable all Telegram notifications"
                  : "Enable all Telegram notifications"
              }
            />
          </div>
        </div>

        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Deposits below the minimum are still credited normally — they just
            don&apos;t post an alert, so the chat isn&apos;t flooded by small
            ones. Set it to <code>0</code> to alert on every deposit.
          </p>
        </div>

        <div className="max-w-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="telegram-deposit-min">Min deposit ($)</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {thresholdHint}
            </span>
          </div>
          <Input
            id="telegram-deposit-min"
            type="number"
            step="1"
            min="0"
            max={MAX_DEPOSIT_MIN_USD}
            value={depositMin}
            onChange={(e) => setDepositMin(e.target.value)}
            disabled={isPending || !master}
          />
        </div>

        {/* Per-notification toggles — dimmed while the master switch is off,
            since none of them can fire in that state. */}
        <div
          className={cn(
            "space-y-1 transition-opacity",
            !master && "pointer-events-none opacity-50",
          )}
        >
          <p className="text-xs font-medium text-muted-foreground">
            Per notification
          </p>
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {TOGGLES.map(({ field, label, hint }) => (
              <div
                key={field}
                className="flex items-center justify-between gap-4 px-3 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <Label
                    htmlFor={`telegram-${field}`}
                    className="text-sm font-normal"
                  >
                    {label}
                  </Label>
                  <p className="text-[11px] text-muted-foreground">{hint}</p>
                </div>
                <Switch
                  id={`telegram-${field}`}
                  checked={toggles[field]}
                  onCheckedChange={(next) => setToggle(field, next)}
                  disabled={isPending || !master}
                  aria-label={`${toggles[field] ? "Disable" : "Enable"} ${label} alerts`}
                />
              </div>
            ))}
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
