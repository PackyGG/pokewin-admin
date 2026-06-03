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
import { Spinner } from "@/components/ux";
import { updateRainConfig } from "./actions";

/**
 * Rain config editor. Reads initial values from the server component
 * (site_config table) and lets an admin update all four rain-related
 * site_config keys in one place.
 *
 * Only fields the admin actually changed are sent to the server action,
 * so the audit event records exactly what was touched instead of a
 * full overwrite of every key.
 */
export function RainConfigCard({
  initial,
}: {
  initial: {
    defaultBaseAmountUsd: number | null;
    liveBaseAmountUsd: number | null;
    durationMinutes: number | null;
    frequencyMs: number | null;
  };
}) {
  const [isPending, startTransition] = useTransition();
  const [defaultBaseAmount, setDefaultBaseAmount] = useState(
    initial.defaultBaseAmountUsd != null
      ? String(initial.defaultBaseAmountUsd)
      : "",
  );
  const [liveBaseAmount, setLiveBaseAmount] = useState(
    initial.liveBaseAmountUsd != null
      ? String(initial.liveBaseAmountUsd)
      : "",
  );
  const [durationMinutes, setDurationMinutes] = useState(
    initial.durationMinutes != null ? String(initial.durationMinutes) : "",
  );
  const [frequencyMs, setFrequencyMs] = useState(
    initial.frequencyMs != null ? String(initial.frequencyMs) : "",
  );

  const defaultBaseChanged =
    defaultBaseAmount.trim() !== "" &&
    Number(defaultBaseAmount) !== initial.defaultBaseAmountUsd;
  const liveBaseChanged =
    liveBaseAmount.trim() !== "" &&
    Number(liveBaseAmount) !== initial.liveBaseAmountUsd;
  const durationChanged =
    durationMinutes.trim() !== "" &&
    Number(durationMinutes) !== initial.durationMinutes;
  const frequencyChanged =
    frequencyMs.trim() !== "" && Number(frequencyMs) !== initial.frequencyMs;
  const dirty =
    defaultBaseChanged ||
    liveBaseChanged ||
    durationChanged ||
    frequencyChanged;

  function handleSave() {
    const payload: {
      defaultBaseAmountUsd?: number;
      liveBaseAmountUsd?: number;
      durationMinutes?: number;
      frequencyMs?: number;
    } = {};

    if (defaultBaseChanged) {
      const n = Number(defaultBaseAmount);
      if (!Number.isFinite(n) || n < 0) {
        toast.error("Default base amount must be a non-negative number");
        return;
      }
      payload.defaultBaseAmountUsd = n;
    }

    if (liveBaseChanged) {
      const n = Number(liveBaseAmount);
      if (!Number.isFinite(n) || n < 0) {
        toast.error("Live base amount must be a non-negative number");
        return;
      }
      payload.liveBaseAmountUsd = n;
    }

    if (durationChanged) {
      const n = Number(durationMinutes);
      if (!Number.isInteger(n) || n <= 0) {
        toast.error("Duration minutes must be a positive integer");
        return;
      }
      payload.durationMinutes = n;
    }

    if (frequencyChanged) {
      const n = Number(frequencyMs);
      if (!Number.isInteger(n) || n < 60000 || n > 86400000) {
        toast.error(
          "Frequency must be a whole number of milliseconds between 60000 (1 min) and 86400000 (24h)",
        );
        return;
      }
      payload.frequencyMs = n;
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
        <CardTitle className="text-sm font-medium">Rain Configuration</CardTitle>
        <CardDescription>
          All four rain-related keys in{" "}
          <code className="rounded bg-muted px-1 text-[11px]">site_config</code>{" "}
          are managed here. Saving upserts the value and pings the backend so
          its cache reloads.
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
              The new values only take effect once the game backend actually
              consumes the four keys (<code>rain_base_amount_usd</code>,{" "}
              <code>rain_default_base_amount</code>,{" "}
              <code>rain_duration_minutes</code>, <code>rain_duration_ms</code>).
              Note: <code>rain_duration_minutes</code> is the duration of one
              rain (starts_at → ends_at), while <code>rain_duration_ms</code>{" "}
              is the frequency BETWEEN rains.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="rain-live-base-amount">
              Live base amount (USD)
            </Label>
            <Input
              id="rain-live-base-amount"
              type="number"
              step="0.01"
              min="0"
              value={liveBaseAmount}
              onChange={(e) => setLiveBaseAmount(e.target.value)}
              placeholder="2.00"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Active baseline rain pot. Backend reads this when starting a
              rain. Key: <code>rain_base_amount_usd</code>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rain-default-base-amount">
              Default base amount (USD)
            </Label>
            <Input
              id="rain-default-base-amount"
              type="number"
              step="0.01"
              min="0"
              value={defaultBaseAmount}
              onChange={(e) => setDefaultBaseAmount(e.target.value)}
              placeholder="2.00"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Seeds the <code>base_amount_usd</code> column on newly created
              rains. Key: <code>rain_default_base_amount</code>
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

          <div className="space-y-2">
            <Label htmlFor="rain-frequency">Frequency (ms between rains)</Label>
            <Input
              id="rain-frequency"
              type="number"
              step="1"
              min="60000"
              max="86400000"
              value={frequencyMs}
              onChange={(e) => setFrequencyMs(e.target.value)}
              placeholder="3600000"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Time between two rain starts in milliseconds. 3600000 = 1h,
              10800000 = 3h. Key: <code>rain_duration_ms</code>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={!dirty || isPending}>
            {isPending && <Spinner size={15} className="text-current" />}
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
