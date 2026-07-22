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
import { updateTelegramNotificationsAction } from "./telegram-notifications-actions";
import type { TelegramNotificationSettings } from "@/lib/backend-api/telegram-notifications";

/**
 * Telegram admin-notification settings editor.
 *
 * Two knobs for the alerts the game backend posts to the ops chat: the
 * minimum deposit USD that triggers a "deposit confirmed" alert, and whether
 * each new signup posts one. Both apply on the backend's next notification —
 * it reads them per-call, so there's no restart or redeploy.
 *
 * `initial === null` means the backend read failed (the telegram-notifications
 * endpoint isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable controls rather than crashing /security.
 */

const MAX_DEPOSIT_MIN_USD = 100_000;

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
  const [signupEnabled, setSignupEnabled] = useState<boolean>(
    () => initial?.signupNotificationsEnabled ?? true,
  );

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Telegram Notifications
          </CardTitle>
          <CardDescription>
            Minimum deposit that triggers an alert, and new-signup alerts.
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

  const handleSave = () => {
    const minRaw = depositMin.trim();

    const updates: {
      depositMinUsd?: number;
      signupNotificationsEnabled?: boolean;
    } = {};

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

    if (signupEnabled !== base.signupNotificationsEnabled) {
      updates.signupNotificationsEnabled = signupEnabled;
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
          Controls the alerts the backend posts to the admin chat. Saving writes
          through the backend, which validates and refreshes its own cache —
          changes apply to the next notification, no restart needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Deposits below the minimum are still credited normally — they just
            don&apos;t post an alert, so the chat isn&apos;t flooded by small
            ones. Set it to <code>0</code> to alert on every deposit.
          </p>
        </div>

        <div className="grid max-w-md gap-4 sm:grid-cols-2">
          <div className="space-y-2">
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
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Alert only on deposits at or above this, e.g. <code>5</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="telegram-signup-alerts">New signup alerts</Label>
            <div className="flex h-9 items-center gap-2.5">
              <Switch
                id="telegram-signup-alerts"
                checked={signupEnabled}
                onCheckedChange={setSignupEnabled}
                disabled={isPending}
                aria-label={
                  signupEnabled
                    ? "Disable new signup alerts"
                    : "Enable new signup alerts"
                }
              />
              <span className="text-sm text-muted-foreground">
                {signupEnabled ? "On" : "Off"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Post an alert for each new user registration.
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
