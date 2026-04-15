"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
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
import { updateRainConfig } from "./actions";

/**
 * Rain config editor. Reads initial values from the server component
 * (site_config table) and lets an admin update the defaults applied
 * to newly created rain instances.
 *
 * Both fields are optional on submit — only the values that changed
 * are sent through so the audit event records exactly what the admin
 * touched, not a full overwrite.
 */
export function RainConfigCard({
  initial,
}: {
  initial: {
    defaultBaseAmountUsd: number | null;
    durationMinutes: number | null;
  };
}) {
  const [isPending, startTransition] = useTransition();
  const [baseAmount, setBaseAmount] = useState(
    initial.defaultBaseAmountUsd != null
      ? String(initial.defaultBaseAmountUsd)
      : "",
  );
  const [durationMinutes, setDurationMinutes] = useState(
    initial.durationMinutes != null ? String(initial.durationMinutes) : "",
  );

  const baseAmountChanged =
    baseAmount.trim() !== "" &&
    Number(baseAmount) !== initial.defaultBaseAmountUsd;
  const durationChanged =
    durationMinutes.trim() !== "" &&
    Number(durationMinutes) !== initial.durationMinutes;
  const dirty = baseAmountChanged || durationChanged;

  function handleSave() {
    const payload: {
      defaultBaseAmountUsd?: number;
      durationMinutes?: number;
    } = {};

    if (baseAmountChanged) {
      const n = Number(baseAmount);
      if (!Number.isFinite(n) || n < 0) {
        toast.error("Default base amount must be a non-negative number");
        return;
      }
      payload.defaultBaseAmountUsd = n;
    }

    if (durationChanged) {
      const n = Number(durationMinutes);
      if (!Number.isInteger(n) || n <= 0) {
        toast.error("Duration minutes must be a positive integer");
        return;
      }
      payload.durationMinutes = n;
    }

    if (Object.keys(payload).length === 0) return;

    startTransition(async () => {
      try {
        await updateRainConfig(payload);
        toast.success("Rain config updated");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update rain config",
        );
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Rain Defaults</CardTitle>
        <CardDescription>
          Values written to <code className="rounded bg-muted px-1 text-[11px]">site_config</code>{" "}
          and applied to newly created rain instances.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Honesty banner — these values only take effect if the game
            backend is actually wired to read the keys below. */}
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">Backend must read these keys</p>
            <p className="text-amber-600/80 dark:text-amber-400/80">
              Saving here upserts the values into{" "}
              <code className="rounded bg-amber-500/10 px-1">site_config</code>{" "}
              and pings the backend via{" "}
              <code className="rounded bg-amber-500/10 px-1">/admin/refresh_site_config</code>.
              The new values only take effect once the game backend is
              actually wired to consume <code>rain_default_base_amount</code>{" "}
              and <code>rain_duration_minutes</code>. If the backend still
              hardcodes the defaults, changes here will persist in the DB
              but have no runtime effect.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="rain-base-amount">Default base amount (USD)</Label>
            <Input
              id="rain-base-amount"
              type="number"
              step="0.01"
              min="0"
              value={baseAmount}
              onChange={(e) => setBaseAmount(e.target.value)}
              placeholder="2.00"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Seeds the <code>base_amount_usd</code> column on new rains.
              Key: <code>rain_default_base_amount</code>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rain-duration">Duration (minutes)</Label>
            <Input
              id="rain-duration"
              type="number"
              step="1"
              min="1"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              placeholder="60"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Sets <code>ends_at = starts_at + N minutes</code> on new rains.
              Key: <code>rain_duration_minutes</code>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={!dirty || isPending}>
            {isPending ? "Saving..." : "Save changes"}
          </Button>
          {!dirty && (
            <span className="text-xs text-muted-foreground">
              No pending changes
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
