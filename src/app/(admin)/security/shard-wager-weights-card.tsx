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
import { updateShardWagerWeightsAction } from "./shard-wager-weights-actions";
import type { ShardWagerWeights } from "@/lib/backend-api/shard-wager-weights";

/**
 * Per-game shard wager-weight editor — how much each game's wagers count
 * toward EARNING SHARDS (formerly "tickets").
 *
 * Weights are stored on the backend in basis points (10000 bps = 1×), but
 * admins think in multipliers, so the form is in ×-multipliers with a live
 * "= N bps" hint (same convention as the leaderboard / rakeback weight cards
 * above it). On save we convert × → bps (Math.round(x * 10000), clamped
 * 0..1_000_000) and send ONLY the changed fields, so the audit event
 * records exactly what moved.
 *
 * `initial === null` means the backend read failed (the shard-weights branch
 * isn't deployed yet) — render a muted "awaiting backend deploy" state with
 * no editable inputs rather than crashing /security.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type FieldKey = keyof ShardWagerWeights;

const FIELDS: {
  key: FieldKey;
  label: string;
  help: React.ReactNode;
}[] = [
  {
    key: "packs_bps",
    label: "Packs weight",
    help: (
      <>
        How much pack wagers count toward earning shards. Default 1× — a $100
        pack wager accrues $100 of shard progress.
      </>
    ),
  },
  {
    key: "battles_bps",
    label: "Battles weight",
    help: (
      <>
        How much battle wagers count toward earning shards. Default 1× — a
        $100 battle wager accrues $100 of shard progress.
      </>
    ),
  },
  {
    key: "upgrader_bps",
    label: "Upgrader weight",
    help: (
      <>
        How much upgrader wagers count toward earning shards. Default 0.8×;{" "}
        <code>0×</code> means upgrader bets earn no shards.
      </>
    ),
  },
];

function bpsToX(bps: number): string {
  return String(bps / BPS_PER_X);
}

export function ShardWagerWeightsCard({
  initial,
}: {
  initial: ShardWagerWeights | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Form state: one ×-multiplier string per field. Seeded from the initial
  // bps values. Hooks must run unconditionally, so this is declared even
  // when initial is null (the degraded branch returns before using it).
  const [values, setValues] = useState<Record<FieldKey, string>>(() => {
    const seed = {} as Record<FieldKey, string>;
    for (const f of FIELDS) {
      seed[f.key] = initial ? bpsToX(initial[f.key]) : "";
    }
    return seed;
  });

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Shard Wager Weights
          </CardTitle>
          <CardDescription>
            Per-game weights for how much each game&apos;s wagers count toward
            earning shards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The shard wager-weight endpoints aren&apos;t reachable on the
                current backend deploy. This card becomes editable once the
                feature ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    const payload: Partial<Record<FieldKey, number>> = {};

    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      if (raw === "") continue; // empty → leave unchanged
      const x = Number(raw);
      if (!Number.isFinite(x) || x < 0) {
        toast.error(`${f.label}: multiplier must be a non-negative number`);
        return;
      }
      const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));
      if (bps !== initial[f.key]) {
        payload[f.key] = bps;
      }
    }

    if (Object.keys(payload).length === 0) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateShardWagerWeightsAction(payload);
      if (result.success) {
        toast.success("Shard wager weights updated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Shard Wager Weights
        </CardTitle>
        <CardDescription>
          How much each game&apos;s wagers count toward earning shards. Values
          are multipliers (1× = 10000 bps). Applied to self-funded wagers
          only. Saving writes through the backend, which validates and
          refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Weights are frozen on each wager at bet time — changes apply to
            future wagers only and never re-touch shards already earned or the
            per-user carry/remainder. Independent from the withdrawal,
            leaderboard and rakeback weights; composes with the per-source
            shard weights below.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {FIELDS.map((f) => {
            const raw = values[f.key].trim();
            const x = raw === "" ? null : Number(raw);
            const bpsHint =
              x !== null && Number.isFinite(x) && x >= 0
                ? `= ${Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))} bps`
                : "= — bps";
            return (
              <div key={f.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`shw-${f.key}`}>{f.label} (×)</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint}
                  </span>
                </div>
                <Input
                  id={`shw-${f.key}`}
                  type="number"
                  step="0.05"
                  min="0"
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  disabled={isPending}
                />
                <p className="text-[11px] text-muted-foreground">{f.help}</p>
              </div>
            );
          })}
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
