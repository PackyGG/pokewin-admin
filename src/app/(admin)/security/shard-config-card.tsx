"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { updateShardConfigAction } from "./shard-config-actions";
import type { ShardConfig } from "@/lib/backend-api/shard-config";

/**
 * Shard earn-rate editor — the headline "how many shards do you get when you
 * wager" knob. `usd_per_shard` is how many USD of shard-weighted wager a user
 * must accumulate to earn one shard (default 10 → 1 shard per $10 wagered).
 * Lower = shards earned faster.
 *
 * `initial === null` means the backend read failed (the shard-config endpoint
 * isn't deployed yet) — render a muted "awaiting backend deploy" state with
 * no editable input rather than crashing /security.
 */

const MAX_USD_PER_SHARD = 100_000;

export function ShardConfigCard({ initial }: { initial: ShardConfig | null }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Form state: the USD-per-shard value as a string. Hooks must run
  // unconditionally, so this is declared even when initial is null (the
  // degraded branch returns before using it).
  const [value, setValue] = useState<string>(() =>
    initial ? String(initial.usd_per_shard) : "",
  );

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Shard Earn Rate</CardTitle>
          <CardDescription>
            How much wager a user needs to earn one shard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The shard-config endpoint isn&apos;t reachable on the current
                backend deploy. This card becomes editable once the feature
                ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    const raw = value.trim();
    if (raw === "") {
      toast.error("Enter a USD-per-shard value");
      return;
    }
    const usd = Number(raw);
    if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_USD_PER_SHARD) {
      toast.error(
        `USD per shard must be a number between 0 and ${MAX_USD_PER_SHARD}`,
      );
      return;
    }
    if (usd === initial.usd_per_shard) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateShardConfigAction({ usd_per_shard: usd });
      if (result.success) {
        toast.success("Shard earn rate updated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const raw = value.trim();
  const usd = raw === "" ? null : Number(raw);
  const rateHint =
    usd !== null && Number.isFinite(usd) && usd > 0
      ? `1 shard per $${usd} of weighted wager`
      : "1 shard per $— of weighted wager";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Shard Earn Rate</CardTitle>
        <CardDescription>
          USD of shard-weighted wager a user must accumulate to earn one shard
          (default $10). Lower = shards earned faster. Saving writes through the
          backend, which validates and refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            This is the base rate, applied AFTER the per-game and per-source
            shard weights below. Changes apply to future wagers only and never
            re-touch shards already earned or the per-user carry/remainder.
          </p>
        </div>

        <div className="max-w-xs space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="shard-usd-per-shard">USD per shard ($)</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {rateHint}
            </span>
          </div>
          <Input
            id="shard-usd-per-shard"
            type="number"
            step="0.5"
            min="0"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isPending}
          />
          <p className="text-[11px] text-muted-foreground">
            E.g. <code>10</code> = 1 shard per $10 wagered; <code>5</code> = 1
            shard per $5 wagered (twice as fast).
          </p>
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
