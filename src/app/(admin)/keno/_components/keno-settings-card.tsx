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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { updateWagerRequirementDefaultsAction } from "../../security/wager-requirement-actions";
import { updateLeaderboardWagerWeightsAction } from "../../security/leaderboard-wager-weights-actions";
import { updateRakebackWagerWeightsAction } from "../../security/rakeback-wager-weights-actions";
import { updateKenoConfigAction } from "../actions";
import type { KenoConfig } from "@/lib/backend-api/keno-config";
import type { WagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import type { LeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";
import {
  KENO_DEFAULT_MAX_BET_USD,
  KENO_DEFAULT_MAX_WIN_USD,
  KENO_MAX_CONFIGURABLE_BET_USD,
  KENO_MIN_BET_USD,
} from "@/lib/keno/payouts";

/**
 * Every admin-editable keno setting, in one place.
 *
 * Keno's maximum bet, maximum win, and three live weights are exposed by four
 * backend admin endpoints. This card consolidates them in the dedicated
 * Analytics → Games → Keno workspace.
 *
 * It is the sole editor for all five Keno keys. The destination-oriented
 * cards and generic site_config table on /security deliberately omit them,
 * so each key has exactly one editable surface.
 *
 * Saving reuses the established security server actions, so auth, the audit
 * event, and cache revalidation keep the same production contract — one audit
 * record per key group, recording that group's real old → new.
 *
 * The minimum bet, grid, draw count, pick range, risk modes and payout tables
 * remain compile-time backend constants. The shard weight
 * (shard_wager_weight_keno_bps) is omitted because Shards are retired.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type WeightFieldKey = "withdrawal" | "leaderboard" | "rakeback";

const FIELDS: {
  key: WeightFieldKey;
  label: string;
  configKey: string;
  help: React.ReactNode;
}[] = [
  {
    key: "withdrawal",
    label: "Withdrawal requirement weight",
    configKey: "wager_weight_keno_bps",
    help: (
      <>
        How much keno wagers count toward the withdrawal wager requirement.
        Default 0.8× — a $100 keno bet clears only $80 of the requirement.
      </>
    ),
  },
  {
    key: "leaderboard",
    label: "Leaderboard weight",
    configKey: "leaderboard_wager_weight_keno_bps",
    help: (
      <>
        How much keno wagers count on official races AND creator
        leaderboards. Default 1×; <code>0×</code> removes keno from
        leaderboards entirely.
      </>
    ),
  },
  {
    key: "rakeback",
    label: "Rakeback weight",
    configKey: "rakeback_wager_weight_keno_bps",
    help: (
      <>
        How much keno wagers feed the rakeback base. Default 1×;{" "}
        <code>0×</code> means keno earns no rakeback.
      </>
    ),
  },
];

function bpsToX(bps: number | undefined): string {
  return typeof bps === "number" ? String(bps / BPS_PER_X) : "";
}

export function KenoSettingsCard({
  kenoConfig,
  wagerDefaults,
  leaderboardWeights,
  rakebackWeights,
  canEdit,
}: {
  kenoConfig: KenoConfig | null;
  wagerDefaults: WagerRequirementDefaults | null;
  leaderboardWeights: LeaderboardWagerWeights | null;
  rakebackWeights: RakebackWagerWeights | null;
  canEdit: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline per field, flattened out of the three source
  // objects. Re-baselined in place after a successful save so the card
  // reflects what persisted WITHOUT a router.refresh() (no scroll jump) —
  // same contract as the destination-oriented cards.
  const [weightBaseline, setWeightBaseline] = useState<
    Record<WeightFieldKey, number | undefined>
  >(() => ({
      withdrawal: wagerDefaults?.wager_weight_keno_bps,
      leaderboard: leaderboardWeights?.keno_bps,
      rakeback: rakebackWeights?.keno_bps,
    }));

  const [weightValues, setWeightValues] = useState<
    Record<WeightFieldKey, string>
  >(() => ({
    withdrawal: bpsToX(wagerDefaults?.wager_weight_keno_bps),
    leaderboard: bpsToX(leaderboardWeights?.keno_bps),
    rakeback: bpsToX(rakebackWeights?.keno_bps),
  }));
  const [maxBetBaseline, setMaxBetBaseline] = useState<number | undefined>(
    () => kenoConfig?.max_bet_usd,
  );
  const [maxBetValue, setMaxBetValue] = useState(
    () => kenoConfig?.max_bet_usd.toString() ?? "",
  );
  const [maxWinBaseline, setMaxWinBaseline] = useState<number | undefined>(
    () => kenoConfig?.max_win_usd,
  );
  const [maxWinValue, setMaxWinValue] = useState(
    () => kenoConfig?.max_win_usd.toString() ?? "",
  );

  // All four reads failed (or the backend predates Keno config entirely) —
  // there is nothing meaningful to edit, so degrade to a notice rather than
  // rendering dead inputs. Mirrors the per-game cards' `!initial` branch.
  const anyAvailable =
    kenoConfig !== null ||
    wagerDefaults !== null ||
    leaderboardWeights !== null ||
    rakebackWeights !== null;

  if (!anyAvailable) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Keno system configuration
          </CardTitle>
          <CardDescription>
            Every admin-editable Keno setting, in one place.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not reachable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                None of the Keno configuration endpoints responded, so the
                current values are unknown. This card becomes editable once
                the backend is reachable again.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    const changedWeights: Partial<Record<WeightFieldKey, number>> = {};

    for (const f of FIELDS) {
      const raw = weightValues[f.key].trim();
      if (raw === "") continue; // empty → leave unchanged
      const x = Number(raw);
      if (!Number.isFinite(x) || x < 0) {
        toast.error(`${f.label}: multiplier must be a non-negative number`);
        return;
      }
      const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));
      if (bps !== weightBaseline[f.key]) {
        changedWeights[f.key] = bps;
      }
    }

    let changedMaxBet: number | undefined;
    let parsedMaxBet = maxBetBaseline;
    if (maxBetBaseline !== undefined) {
      const raw = maxBetValue.trim();
      if (raw === "") {
        toast.error("Maximum bet is required");
        return;
      }
      const parsed = Number(raw);
      if (
        !Number.isFinite(parsed) ||
        parsed < KENO_MIN_BET_USD ||
        parsed > KENO_MAX_CONFIGURABLE_BET_USD
      ) {
        toast.error(
          `Maximum bet must be between $${KENO_MIN_BET_USD.toFixed(2)} and $${KENO_MAX_CONFIGURABLE_BET_USD.toLocaleString("en-US")}`,
        );
        return;
      }
      if (parsed !== maxBetBaseline) {
        changedMaxBet = parsed;
      }
      parsedMaxBet = parsed;
    }

    let changedMaxWin: number | undefined;
    let parsedMaxWin = maxWinBaseline;
    if (maxWinBaseline !== undefined) {
      const raw = maxWinValue.trim();
      if (raw === "") {
        toast.error("Maximum win is required");
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error("Maximum win must be greater than $0");
        return;
      }
      if (parsed !== maxWinBaseline) {
        changedMaxWin = parsed;
      }
      parsedMaxWin = parsed;
    }

    if (
      changedMaxBet === undefined &&
      changedMaxWin === undefined &&
      Object.keys(changedWeights).length === 0
    ) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      // One call per key group that actually moved. Each goes through that
      // group's existing action, so each writes its own audit record with its
      // own old → new. Sequential rather than parallel: they all write
      // site_config on the same backend and each re-reads for its audit, so
      // serialising keeps those read-then-write pairs from interleaving.
      const failures: string[] = [];
      const savedWeights = { ...weightBaseline };
      let savedMaxBet = maxBetBaseline;
      let savedMaxWin = maxWinBaseline;

      if (
        (changedMaxBet !== undefined || changedMaxWin !== undefined) &&
        parsedMaxBet !== undefined &&
        parsedMaxWin !== undefined
      ) {
        const result = await updateKenoConfigAction({
          max_bet_usd: parsedMaxBet,
          max_win_usd: parsedMaxWin,
        });
        if (result.success) {
          savedMaxBet = result.data.max_bet_usd;
          savedMaxWin = result.data.max_win_usd;
        } else {
          failures.push(`Bet and win limits: ${result.error}`);
        }
      }

      if (changedWeights.withdrawal !== undefined) {
        const r = await updateWagerRequirementDefaultsAction({
          wager_weight_keno_bps: changedWeights.withdrawal,
        });
        if (r.success) {
          savedWeights.withdrawal = r.data.wager_weight_keno_bps;
        } else {
          failures.push(`Withdrawal requirement: ${r.error}`);
        }
      }

      if (changedWeights.leaderboard !== undefined) {
        const r = await updateLeaderboardWagerWeightsAction({
          keno_bps: changedWeights.leaderboard,
        });
        if (r.success) savedWeights.leaderboard = r.data.keno_bps;
        else failures.push(`Leaderboard: ${r.error}`);
      }

      if (changedWeights.rakeback !== undefined) {
        const r = await updateRakebackWagerWeightsAction({
          keno_bps: changedWeights.rakeback,
        });
        if (r.success) savedWeights.rakeback = r.data.keno_bps;
        else failures.push(`Rakeback: ${r.error}`);
      }

      // Re-baseline to what actually persisted, including on a partial
      // failure — a field that saved must not stay flagged as dirty just
      // because a sibling field failed.
      setMaxBetBaseline(savedMaxBet);
      setMaxBetValue(savedMaxBet?.toString() ?? "");
      setMaxWinBaseline(savedMaxWin);
      setMaxWinValue(savedMaxWin?.toString() ?? "");
      setWeightBaseline(savedWeights);
      setWeightValues({
        withdrawal: bpsToX(savedWeights.withdrawal),
        leaderboard: bpsToX(savedWeights.leaderboard),
        rakeback: bpsToX(savedWeights.rakeback),
      });

      if (failures.length === 0) {
        toast.success("Keno configuration updated");
      } else {
        toast.error(failures.join(" · "));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Keno system configuration
          </CardTitle>
          <Badge variant="secondary">All 5 active settings</Badge>
        </div>
        <CardDescription>
          Maximum bet, maximum win, and every Keno wager weight. Weight values
          are multipliers (1× = 10000 bps). All saves go through the backend
          admin API and the admin audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            The withdrawal and leaderboard weights are frozen onto each wager
            at bet time — changes apply to future keno bets only and never
            re-price existing progress or standings. The rakeback weight is
            live: it also re-prices still-unclaimed periods, but never settled
            claims. The maximum bet applies immediately to new games. Existing
            games and settled results are unchanged. The maximum win caps the
            final payout after its multiplier is applied.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Maximum bet</p>
              <code className="block truncate text-[10px] text-muted-foreground">
                keno_max_bet_usd
              </code>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="keno-max-bet">USD per game</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Default ${KENO_DEFAULT_MAX_BET_USD.toFixed(2)}
              </span>
            </div>
            <Input
              id="keno-max-bet"
              type="number"
              step="0.01"
              min={KENO_MIN_BET_USD}
              max={KENO_MAX_CONFIGURABLE_BET_USD}
              value={maxBetValue}
              onChange={(event) => setMaxBetValue(event.target.value)}
              disabled={
                isPending || maxBetBaseline === undefined || !canEdit
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {maxBetBaseline === undefined ? (
                <span className="text-amber-600 dark:text-amber-400">
                  Current value unavailable — the Keno config endpoint
                  didn&apos;t respond.
                </span>
              ) : (
                <>
                  Allowed range ${KENO_MIN_BET_USD.toFixed(2)}–$
                  {KENO_MAX_CONFIGURABLE_BET_USD.toLocaleString("en-US")}.
                  Applies immediately to future games.
                </>
              )}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Maximum win</p>
              <code className="block truncate text-[10px] text-muted-foreground">
                keno_max_win_usd
              </code>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="keno-max-win">USD per game</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Default ${KENO_DEFAULT_MAX_WIN_USD.toLocaleString("en-US")}
              </span>
            </div>
            <Input
              id="keno-max-win"
              type="number"
              step="0.01"
              min="0.01"
              value={maxWinValue}
              onChange={(event) => setMaxWinValue(event.target.value)}
              disabled={
                isPending || maxWinBaseline === undefined || !canEdit
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {maxWinBaseline === undefined ? (
                <span className="text-amber-600 dark:text-amber-400">
                  Current value unavailable — the Keno config endpoint
                  didn&apos;t return a win cap.
                </span>
              ) : (
                <>
                  Caps the final payout after the selected multiplier. Applies
                  immediately to future games.
                </>
              )}
            </p>
          </div>

          {FIELDS.map((f) => {
            const raw = weightValues[f.key].trim();
            const x = raw === "" ? null : Number(raw);
            const bpsHint =
              x !== null && Number.isFinite(x) && x >= 0
                ? `= ${Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))} bps`
                : "= — bps";
            // A single endpoint being down shouldn't block the other two.
            const unavailable = weightBaseline[f.key] === undefined;
            return (
              <div
                key={f.key}
                className="space-y-3 rounded-lg border bg-muted/20 p-4"
              >
                <div className="space-y-1">
                  <p className="text-sm font-medium">{f.label}</p>
                  <code className="block truncate text-[10px] text-muted-foreground">
                    {f.configKey}
                  </code>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`keno-${f.key}`}>Multiplier (×)</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint}
                  </span>
                </div>
                <Input
                  id={`keno-${f.key}`}
                  type="number"
                  step="0.05"
                  min="0"
                  value={weightValues[f.key]}
                  onChange={(e) =>
                    setWeightValues((prev) => ({
                      ...prev,
                      [f.key]: e.target.value,
                    }))
                  }
                  disabled={isPending || unavailable || !canEdit}
                />
                <p className="text-[11px] text-muted-foreground">
                  {unavailable ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      Current value unavailable — this endpoint didn&apos;t
                      respond.
                    </span>
                  ) : (
                    f.help
                  )}
                </p>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={isPending || !canEdit}>
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending
              ? "Saving..."
              : canEdit
                ? "Save changes"
                : "Admin access required"}
          </Button>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The former <code>shard_wager_weight_keno_bps</code> key is not an
          active Keno setting. Shards were retired site-wide, so that key
          remains intentionally hidden and cannot be changed from the admin.
        </p>
      </CardContent>
    </Card>
  );
}
