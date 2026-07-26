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
import { updateRakebackWagerWeightsAction } from "./rakeback-wager-weights-actions";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";

/**
 * Per-game rakeback wager-weight editor — how much each game's wagers feed
 * the rakeback wager base.
 *
 * Weights are stored on the backend in basis points (10000 bps = 1×), but
 * admins think in multipliers, so the form is in ×-multipliers with a live
 * "= N bps" hint (same convention as the wager-requirement / leaderboard
 * weight cards above it). On save we convert × → bps
 * (Math.round(x * 10000), clamped 0..1_000_000) and send ONLY the changed
 * fields, so the audit event records exactly what moved.
 *
 * `initial === null` means the backend read failed (the rakeback-weights
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable inputs rather than crashing /security.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type FieldKey = keyof RakebackWagerWeights;

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
        How much pack wagers count toward rakeback. Default 1× — a $100 pack
        wager adds $100 to the rakeback base.
      </>
    ),
  },
  {
    key: "battles_bps",
    label: "Battles weight",
    help: (
      <>
        How much battle wagers count toward rakeback. Default 1× — a $100
        battle wager adds $100 to the rakeback base.
      </>
    ),
  },
  {
    key: "upgrader_bps",
    label: "Upgrader weight",
    help: (
      <>
        How much upgrader wagers count toward rakeback. Default 1×;{" "}
        <code>0×</code> removes upgrader bets from rakeback entirely.
      </>
    ),
  },
  // Keno is deliberately absent: it is edited in Content → Keno, so
  // rakeback_wager_weight_keno_bps has exactly one editable surface.
];

// Tolerates a field the backend hasn't shipped yet (e.g. keno_bps against an
// older deploy): an absent weight seeds an EMPTY input rather than "NaN", and
// handleSave's `raw === ""` guard then leaves it untouched unless an admin
// actually types a value.
function bpsToX(bps: number | undefined): string {
  return typeof bps === "number" ? String(bps / BPS_PER_X) : "";
}

export function RakebackWagerWeightsCard({
  initial,
}: {
  initial: RakebackWagerWeights | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved weights after a successful write, so the card
  // reflects the saved values in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [baseline, setBaseline] = useState<RakebackWagerWeights | null>(
    initial,
  );

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
            Rakeback Wager Weights
          </CardTitle>
          <CardDescription>
            Per-game weights for how much each game feeds the rakeback base.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The rakeback wager-weight endpoints aren&apos;t reachable on
                the current backend deploy. This card becomes editable once
                the feature ships to the backend.
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
      if (bps !== base[f.key]) {
        payload[f.key] = bps;
      }
    }

    if (Object.keys(payload).length === 0) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateRakebackWagerWeightsAction(payload);
      if (result.success) {
        toast.success("Rakeback wager weights updated");
        // Re-baseline to the saved weights in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating baseline just re-arms the dirty-check for the next edit.
        setBaseline(result.data);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Rakeback Wager Weights
        </CardTitle>
        <CardDescription>
          How much each game&apos;s wagers feed the rakeback base (then
          multiplied by the per-tier rakeback %). Values are multipliers (1×
          = 10000 bps). Saving writes through the backend, which validates
          and refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Applied live when claimable rakeback is computed — lowering a
            weight shrinks rakeback on still-unclaimed periods but never
            re-touches already-settled claims. Independent from the
            leaderboard and withdrawal weights above: total wagered, levels,
            races and the withdrawal gate are unaffected.
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
                  <Label htmlFor={`rww-${f.key}`}>{f.label} (×)</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint}
                  </span>
                </div>
                <Input
                  id={`rww-${f.key}`}
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
