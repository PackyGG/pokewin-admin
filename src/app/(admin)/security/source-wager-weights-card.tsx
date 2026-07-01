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
import { updateSourceWagerWeightsAction } from "./source-wager-weights-actions";
import type {
  SourceWagerWeights,
  FundingSourceWeights,
  UpdateSourceWagerWeightsInput,
} from "@/lib/backend-api/source-wager-weights";

/**
 * Funding-source wager-weight editor — how much wager FUNDED BY each bonus
 * source counts toward the withdrawal requirement, rakeback, race
 * leaderboards and shard earning, relative to deposit-funded wager (the
 * implicit 100% baseline).
 *
 * Stored on the backend in basis points (10000 bps = 1×), but admins think
 * in multipliers, so the form is in ×-multipliers with a live "= N bps" hint
 * (same convention as the rakeback / leaderboard weight cards above). On save
 * we convert × → bps (Math.round(x * 10000), clamped 0..1_000_000) and send
 * ONLY the changed fields, so the audit event records exactly what moved.
 *
 * `initial === null` means the backend read failed (the source-weights branch
 * isn't deployed yet) — render a muted "awaiting backend deploy" state with no
 * editable inputs rather than crashing /security. A destination missing from
 * the response (e.g. `leaderboard` against a backend deploy that predates the
 * race source weights) degrades the same way, but per-destination.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type Destination = "withdrawal" | "rakeback" | "leaderboard" | "shards";
type SourceKey = keyof FundingSourceWeights;

const DESTINATIONS: {
  key: Destination;
  title: string;
  help: React.ReactNode;
}[] = [
  {
    key: "withdrawal",
    title: "Withdrawal requirement",
    help: (
      <>
        How much bonus-funded wager counts toward clearing the withdrawal
        wager requirement. Frozen at wager time.
      </>
    ),
  },
  {
    key: "rakeback",
    title: "Rakeback",
    help: (
      <>
        How much bonus-funded wager feeds the rakeback base. Applied live at
        claim — changes affect still-unclaimed periods only.
      </>
    ),
  },
  {
    key: "leaderboard",
    title: "Races / leaderboards",
    help: (
      <>
        How much bonus-funded wager counts on official race leaderboards.
        Frozen at wager time — changes affect future wagers only and never
        reshuffle existing standings. Creator/affiliate leaderboard volume is
        unaffected (per-game weights only).
      </>
    ),
  },
  {
    key: "shards",
    title: "Shard earning",
    help: (
      <>
        How much bonus-funded wager counts toward earning shards. Frozen at
        wager time — changes affect future wagers only and never re-touch
        shards already earned. Composes with the per-game shard weights.
      </>
    ),
  },
];

const SOURCES: { key: SourceKey; label: string }[] = [
  { key: "race_prize", label: "Race / LB prizes" },
  { key: "bonus_other", label: "Rain + rewards" },
  { key: "rakeback", label: "Rakeback" },
  { key: "affiliate", label: "Affiliate" },
  { key: "tips", label: "Tips" },
];

const cellKey = (d: Destination, s: SourceKey) => `${d}.${s}`;

function bpsToX(bps: number): string {
  return String(bps / BPS_PER_X);
}

export function SourceWagerWeightsCard({
  initial,
}: {
  initial: SourceWagerWeights | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth config for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved weights after a successful write, so the card
  // reflects the saved values in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [serverConfig, setServerConfig] = useState<SourceWagerWeights | null>(
    initial,
  );

  // Form state: one ×-multiplier string per (destination, source) cell.
  // Hooks must run unconditionally, so this is declared even when initial is
  // null (the degraded branch returns before using it).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const d of DESTINATIONS) {
      const group = initial?.[d.key];
      for (const s of SOURCES) {
        seed[cellKey(d.key, s.key)] = group ? bpsToX(group[s.key]) : "";
      }
    }
    return seed;
  });

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Funding-Source Wager Weights
          </CardTitle>
          <CardDescription>
            Per-source weights for how much bonus-funded wager counts toward
            the withdrawal requirement, rakeback, race leaderboards and shard
            earning.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The funding-source wager-weight endpoints aren&apos;t reachable
                on the current backend deploy. This card becomes editable once
                the feature ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Past the `!initial` guard above, initial is non-null; serverConfig is
  // seeded from it (and re-baselined on save), so this is the current server
  // truth.
  const cfg = serverConfig ?? initial;

  const handleSave = () => {
    const payload: UpdateSourceWagerWeightsInput = {};

    for (const d of DESTINATIONS) {
      const baseline = cfg[d.key];
      if (!baseline) continue; // destination not on this backend deploy
      for (const s of SOURCES) {
        const raw = values[cellKey(d.key, s.key)].trim();
        if (raw === "") continue; // empty → leave unchanged
        const x = Number(raw);
        if (!Number.isFinite(x) || x < 0) {
          toast.error(
            `${d.title} · ${s.label}: multiplier must be a non-negative number`,
          );
          return;
        }
        const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));
        if (bps !== baseline[s.key]) {
          const group = (payload[d.key] ??= {});
          group[s.key] = bps;
        }
      }
    }

    if (DESTINATIONS.every((d) => !payload[d.key])) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateSourceWagerWeightsAction(payload);
      if (result.success) {
        toast.success("Funding-source wager weights updated");
        // Re-baseline to the saved weights in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating serverConfig just re-arms the dirty-check for the next edit.
        setServerConfig(result.data);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Funding-Source Wager Weights
        </CardTitle>
        <CardDescription>
          How much wager funded by each bonus source counts toward the
          withdrawal requirement, rakeback, race leaderboards and shard
          earning, relative to deposit-funded wager (the 100% baseline).
          Values are multipliers (1× = 10000 bps). Composes with the per-game
          weights. Saving writes through the backend, which validates and
          refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Only bonuses credited after this feature deployed are
            source-weighted (earlier balances count as deposit-equivalent).
            Withdrawal and races/leaderboards are frozen at wager time
            (changes never reshuffle existing race standings); rakeback is
            applied live to unclaimed periods.
          </p>
        </div>

        {DESTINATIONS.map((d) => (
          <div key={d.key} className="space-y-3">
            <div>
              <h4 className="text-sm font-medium">{d.title}</h4>
              <p className="text-[11px] text-muted-foreground">{d.help}</p>
            </div>
            {!cfg[d.key] ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <p className="text-amber-600/80 dark:text-amber-400/80">
                  Not on the current backend deploy yet — becomes editable
                  once the backend ships this destination.
                </p>
              </div>
            ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {SOURCES.map((s) => {
                const key = cellKey(d.key, s.key);
                const raw = values[key].trim();
                const x = raw === "" ? null : Number(raw);
                const bpsHint =
                  x !== null && Number.isFinite(x) && x >= 0
                    ? `= ${Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))} bps`
                    : "= — bps";
                return (
                  <div key={key} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`sww-${key}`}>{s.label} (×)</Label>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {bpsHint}
                      </span>
                    </div>
                    <Input
                      id={`sww-${key}`}
                      type="number"
                      step="0.05"
                      min="0"
                      value={values[key]}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      disabled={isPending}
                    />
                  </div>
                );
              })}
            </div>
            )}
          </div>
        ))}

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
