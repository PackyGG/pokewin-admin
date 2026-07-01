"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Info, Plus, X } from "lucide-react";
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
import { updateMultiplierWagerWeightsAction } from "./multiplier-wager-weights-actions";
// Runtime constants from the plain shared module — a VALUE import from
// multiplier-wager-weights.ts would pull "server-only" into this client
// bundle (crypto-fees-assets.ts precedent).
import {
  MAX_MULTIPLIER_TIERS,
  type MultiplierWeightDestination,
  type MultiplierTier,
} from "@/lib/backend-api/multiplier-wager-weights-shared";
import type {
  MultiplierWagerWeights,
  UpdateMultiplierWagerWeightsInput,
} from "@/lib/backend-api/multiplier-wager-weights";

/**
 * Odds-based (bet-multiplier) wager-weight editor — per destination an
 * enable toggle plus an ordered tier list that discounts low-multiplier
 * upgrader bets: a bet with payout multiplier m counts at the FIRST tier
 * (ascending bound) where m < max_x, else at 100%. Only upgrader bets have
 * a player-chosen multiplier — packs and battles are unaffected.
 *
 * Stored on the backend as bps ints (10000 = 100%), but admins think in
 * percent, so the weight inputs are % with up to 2 decimals (50 = 50% =
 * 5000 bps) and a live "= N bps" hint. On save we convert % → bps
 * (Math.round(pct * 100)), validate client-side (bound > 1× and strictly
 * ascending, weight 0–100%) and send ONLY the changed destinations; a
 * destination whose tiers changed sends its FULL replacement tier list
 * (the backend replaces the stored list wholesale). Save stays disabled
 * while nothing differs from the loaded config.
 *
 * `initial === null` means the backend read failed (the multiplier-weights
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable inputs rather than crashing /security.
 */

const BPS_PER_PCT = 100;
const MAX_WEIGHT_BPS = 10000; // 100%
const MAX_X = 100000;

// Display order: leaderboard first (the owner's main farming concern),
// then rakeback, shards, withdrawal.
const DESTINATIONS: {
  key: MultiplierWeightDestination;
  title: string;
  help: string;
}[] = [
  {
    key: "leaderboard",
    title: "Races / leaderboards",
    help: "How much low-multiplier upgrader bets count on race leaderboards.",
  },
  {
    key: "rakeback",
    title: "Rakeback",
    help: "How much low-multiplier upgrader bets feed the rakeback base.",
  },
  {
    key: "shards",
    title: "Shard earning",
    help: "How much low-multiplier upgrader bets count toward earning shards.",
  },
  {
    key: "withdrawal",
    title: "Withdrawal requirement",
    help: "How much low-multiplier upgrader bets count toward clearing the withdrawal wager requirement.",
  },
];

type TierRow = { maxX: string; weight: string };
type DestState = { enabled: boolean; tiers: TierRow[] };

/**
 * Parse one tier row into the API shape. Returns an error message when a
 * field is empty / non-numeric / out of range — the caller prefixes the
 * destination + row context for the toast.
 */
const parseRow = (row: TierRow): MultiplierTier | string => {
  const rawMaxX = row.maxX.trim();
  const maxX = Number(rawMaxX);
  if (rawMaxX === "" || !Number.isFinite(maxX)) {
    return "bound must be a number";
  }
  if (maxX <= 1) return "bound must be greater than 1×";
  if (maxX > MAX_X) return `bound must be at most ${MAX_X}×`;

  const rawWeight = row.weight.trim();
  const pct = Number(rawWeight);
  if (rawWeight === "" || !Number.isFinite(pct)) {
    return "weight must be a number";
  }
  const bps = Math.round(pct * BPS_PER_PCT);
  if (bps < 0 || bps > MAX_WEIGHT_BPS) {
    return "weight must be between 0% and 100%";
  }

  return { max_x: maxX, weight_bps: bps };
};

/**
 * Parse a destination's full row list (the wholesale replacement the PUT
 * sends). Errors carry the 1-based tier index for the toast.
 */
const parseTiers = (
  rows: TierRow[],
): { tiers: MultiplierTier[] } | { error: string } => {
  const tiers: MultiplierTier[] = [];
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseRow(rows[i]);
    if (typeof parsed === "string") {
      return { error: `tier ${i + 1}: ${parsed}` };
    }
    if (i > 0 && parsed.max_x <= tiers[i - 1].max_x) {
      return { error: `tier ${i + 1}: bounds must be strictly ascending` };
    }
    tiers.push(parsed);
  }
  return { tiers };
};

const tiersEqual = (a: MultiplierTier[], b: MultiplierTier[]): boolean =>
  a.length === b.length &&
  a.every((t, i) => t.max_x === b[i].max_x && t.weight_bps === b[i].weight_bps);

export function MultiplierWagerWeightsCard({
  initial,
}: {
  initial: MultiplierWagerWeights | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth config for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved config after a successful write, so the card
  // reflects the saved values in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [serverConfig, setServerConfig] =
    useState<MultiplierWagerWeights | null>(initial);

  // Form state: per destination an enabled flag + tier rows (bound × and
  // weight % as strings). Hooks must run unconditionally, so this is
  // declared even when initial is null (the degraded branch returns before
  // using it).
  const [values, setValues] = useState<
    Record<MultiplierWeightDestination, DestState>
  >(() => {
    const seed = {} as Record<MultiplierWeightDestination, DestState>;
    for (const d of DESTINATIONS) {
      const cfg = initial?.[d.key];
      seed[d.key] = cfg
        ? {
            enabled: cfg.enabled,
            tiers: cfg.tiers.map((t) => ({
              maxX: String(t.max_x),
              weight: String(t.weight_bps / BPS_PER_PCT),
            })),
          }
        : { enabled: false, tiers: [] };
    }
    return seed;
  });

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Multiplier Wager Weights
          </CardTitle>
          <CardDescription>
            Per-destination discount tiers for low-multiplier upgrader bets —
            how much they count toward race leaderboards, rakeback, shard
            earning and the withdrawal requirement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The multiplier wager-weight endpoints aren&apos;t reachable on
                the current backend deploy. This card becomes editable once
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

  // Dirty-tracking for the Save button: a destination counts as changed
  // when its toggle differs from the loaded config or its tier list parses
  // to different tiers (unparseable text counts as dirty — the save click
  // then surfaces the validation toast).
  const isDirty = DESTINATIONS.some((d) => {
    const base = cfg[d.key];
    const st = values[d.key];
    if (st.enabled !== base.enabled) return true;
    const parsed = parseTiers(st.tiers);
    if ("error" in parsed) return true;
    return !tiersEqual(parsed.tiers, base.tiers);
  });

  const setTier = (
    dest: MultiplierWeightDestination,
    index: number,
    patch: Partial<TierRow>,
  ) =>
    setValues((prev) => ({
      ...prev,
      [dest]: {
        ...prev[dest],
        tiers: prev[dest].tiers.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        ),
      },
    }));

  const addTier = (dest: MultiplierWeightDestination) =>
    setValues((prev) => ({
      ...prev,
      [dest]: {
        ...prev[dest],
        tiers: [...prev[dest].tiers, { maxX: "", weight: "" }],
      },
    }));

  const removeTier = (dest: MultiplierWeightDestination, index: number) =>
    setValues((prev) => ({
      ...prev,
      [dest]: {
        ...prev[dest],
        tiers: prev[dest].tiers.filter((_, i) => i !== index),
      },
    }));

  const handleSave = () => {
    const payload: UpdateMultiplierWagerWeightsInput = {};

    for (const d of DESTINATIONS) {
      const base = cfg[d.key];
      const st = values[d.key];
      const patch: { enabled?: boolean; tiers?: MultiplierTier[] } = {};

      if (st.enabled !== base.enabled) patch.enabled = st.enabled;

      const parsed = parseTiers(st.tiers);
      if ("error" in parsed) {
        toast.error(`${d.title} · ${parsed.error}`);
        return;
      }
      // Full replacement list, only when it actually changed — the backend
      // replaces the stored tiers wholesale.
      if (!tiersEqual(parsed.tiers, base.tiers)) patch.tiers = parsed.tiers;

      if (patch.enabled !== undefined || patch.tiers !== undefined) {
        payload[d.key] = patch;
      }
    }

    if (DESTINATIONS.every((d) => !payload[d.key])) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateMultiplierWagerWeightsAction(payload);
      if (result.success) {
        toast.success("Multiplier wager weights updated");
        // Re-baseline to the saved config in place — no router.refresh(), so
        // scroll never jumps. The controlled inputs already show these values;
        // updating serverConfig just re-arms the dirty-check (Save disables).
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
          Multiplier Wager Weights
        </CardTitle>
        <CardDescription>
          Discount low-multiplier upgrader bets per destination — an enable
          toggle plus ordered tiers (&quot;below 1.25× → counts 20%&quot;).
          Weights are percent of the bet amount (50% = 5000 bps, up to 2
          decimals). Backend defaults: below 1.25× → 20%, 1.25–1.50× → 50%,
          all destinations disabled. Saving writes through the backend, which
          re-validates the config.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Only upgrader bets have a player-chosen payout multiplier — packs
            and battles always count in full. A bet takes the first tier
            (ascending bound) whose bound is above its multiplier; at or
            above the highest bound it counts 100%. Saving a destination&apos;s
            tiers replaces its stored list wholesale.
          </p>
        </div>

        {DESTINATIONS.map((d) => {
          const st = values[d.key];
          return (
            <div key={d.key} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium">{d.title}</h4>
                  <p className="text-[11px] text-muted-foreground">{d.help}</p>
                </div>
                <Switch
                  checked={st.enabled}
                  onCheckedChange={(checked) =>
                    setValues((prev) => ({
                      ...prev,
                      [d.key]: { ...prev[d.key], enabled: checked },
                    }))
                  }
                  disabled={isPending}
                  aria-label={`${d.title} multiplier weighting enabled`}
                />
              </div>

              {st.tiers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tiers — every bet counts 100% even while enabled.
                </p>
              ) : (
                <div className="space-y-2">
                  {st.tiers.map((row, i) => {
                    const key = `${d.key}-${i}`;
                    const rawWeight = row.weight.trim();
                    const pct = Number(rawWeight);
                    const bpsHint =
                      rawWeight !== "" &&
                      Number.isFinite(pct) &&
                      pct >= 0 &&
                      pct <= 100
                        ? `= ${Math.round(pct * BPS_PER_PCT)} bps`
                        : "= — bps";
                    return (
                      <div
                        key={key}
                        className="flex flex-wrap items-center gap-2 text-sm"
                      >
                        <Label
                          htmlFor={`mww-${key}-max`}
                          className="font-normal text-muted-foreground"
                        >
                          Below
                        </Label>
                        <Input
                          id={`mww-${key}-max`}
                          type="number"
                          step="0.01"
                          min="1"
                          className="w-24"
                          value={row.maxX}
                          onChange={(e) =>
                            setTier(d.key, i, { maxX: e.target.value })
                          }
                          disabled={isPending}
                          aria-label={`${d.title} tier ${i + 1} multiplier bound`}
                        />
                        <span className="text-muted-foreground">
                          × → counts
                        </span>
                        <Input
                          id={`mww-${key}-weight`}
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          className="w-20"
                          value={row.weight}
                          onChange={(e) =>
                            setTier(d.key, i, { weight: e.target.value })
                          }
                          disabled={isPending}
                          aria-label={`${d.title} tier ${i + 1} weight %`}
                        />
                        <span className="text-muted-foreground">%</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {bpsHint}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => removeTier(d.key, i)}
                          disabled={isPending}
                          aria-label={`Remove ${d.title} tier ${i + 1}`}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addTier(d.key)}
                  disabled={
                    isPending || st.tiers.length >= MAX_MULTIPLIER_TIERS
                  }
                >
                  <Plus className="size-3.5" />
                  Add tier
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {st.tiers.length >= MAX_MULTIPLIER_TIERS
                    ? `Max ${MAX_MULTIPLIER_TIERS} tiers.`
                    : st.tiers.length > 0
                      ? "Bets at or above the highest bound count 100%."
                      : null}
                </span>
              </div>
            </div>
          );
        })}

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={isPending || !isDirty}>
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
