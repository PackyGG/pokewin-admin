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
import { updateWagerRequirementDefaultsAction } from "../../security/wager-requirement-actions";
import { updateLeaderboardWagerWeightsAction } from "../../security/leaderboard-wager-weights-actions";
import { updateRakebackWagerWeightsAction } from "../../security/rakeback-wager-weights-actions";
import type { WagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";
import type { LeaderboardWagerWeights } from "@/lib/backend-api/leaderboard-wager-weights";
import type { RakebackWagerWeights } from "@/lib/backend-api/rakeback-wager-weights";

/**
 * Every admin-editable keno setting, in one place.
 *
 * Keno's three live weights live in three different backend endpoints
 * (withdrawal requirement / leaderboards / rakeback). This card consolidates
 * those destinations in the dedicated Content → Keno workspace.
 *
 * It is the sole editor for the three Keno keys. The destination-oriented
 * cards on /security deliberately do not carry a Keno field, so each key has
 * exactly one editable surface.
 *
 * Saving reuses the established security server actions, so auth, the audit
 * event, and cache revalidation keep the same production contract — one audit
 * record per key group, recording that group's real old → new.
 *
 * NOT shown, because they are not configurable: the grid (40), draw count
 * (10), pick range (1–10), bet range ($0.25–$1000), the three risk modes and
 * the payout tables are compile-time constants in the backend
 * (src/utils/keno.ts) with no site_config backing and no admin endpoint —
 * changing them is a backend deploy. The shard weight
 * (shard_wager_weight_keno_bps) is omitted too: the shard surface was retired
 * site-wide, so it is filtered out of /security entirely.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type FieldKey = "withdrawal" | "leaderboard" | "rakeback";

const FIELDS: {
  key: FieldKey;
  label: string;
  help: React.ReactNode;
}[] = [
  {
    key: "withdrawal",
    label: "Withdrawal requirement weight",
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
  wagerDefaults,
  leaderboardWeights,
  rakebackWeights,
  canEdit,
}: {
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
  const [baseline, setBaseline] = useState<Record<FieldKey, number | undefined>>(
    () => ({
      withdrawal: wagerDefaults?.wager_weight_keno_bps,
      leaderboard: leaderboardWeights?.keno_bps,
      rakeback: rakebackWeights?.keno_bps,
    }),
  );

  const [values, setValues] = useState<Record<FieldKey, string>>(() => ({
    withdrawal: bpsToX(wagerDefaults?.wager_weight_keno_bps),
    leaderboard: bpsToX(leaderboardWeights?.keno_bps),
    rakeback: bpsToX(rakebackWeights?.keno_bps),
  }));

  // All three reads failed (or the backend predates keno weights entirely) —
  // there is nothing meaningful to edit, so degrade to a notice rather than
  // rendering three dead inputs. Mirrors the per-game cards' `!initial` branch.
  const anyAvailable =
    wagerDefaults !== null ||
    leaderboardWeights !== null ||
    rakebackWeights !== null;

  if (!anyAvailable) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Keno Settings</CardTitle>
          <CardDescription>
            Every admin-editable keno weight, in one place.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not reachable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                None of the wager-weight endpoints responded, so the current
                keno weights are unknown. This card becomes editable once the
                backend is reachable again.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    const changed: Partial<Record<FieldKey, number>> = {};

    for (const f of FIELDS) {
      const raw = values[f.key].trim();
      if (raw === "") continue; // empty → leave unchanged
      const x = Number(raw);
      if (!Number.isFinite(x) || x < 0) {
        toast.error(`${f.label}: multiplier must be a non-negative number`);
        return;
      }
      const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));
      if (bps !== baseline[f.key]) {
        changed[f.key] = bps;
      }
    }

    if (Object.keys(changed).length === 0) {
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
      const saved = { ...baseline };

      if (changed.withdrawal !== undefined) {
        const r = await updateWagerRequirementDefaultsAction({
          wager_weight_keno_bps: changed.withdrawal,
        });
        if (r.success) saved.withdrawal = r.data.wager_weight_keno_bps;
        else failures.push(`Withdrawal requirement: ${r.error}`);
      }

      if (changed.leaderboard !== undefined) {
        const r = await updateLeaderboardWagerWeightsAction({
          keno_bps: changed.leaderboard,
        });
        if (r.success) saved.leaderboard = r.data.keno_bps;
        else failures.push(`Leaderboard: ${r.error}`);
      }

      if (changed.rakeback !== undefined) {
        const r = await updateRakebackWagerWeightsAction({
          keno_bps: changed.rakeback,
        });
        if (r.success) saved.rakeback = r.data.keno_bps;
        else failures.push(`Rakeback: ${r.error}`);
      }

      // Re-baseline to what actually persisted, including on a partial
      // failure — a field that saved must not stay flagged as dirty just
      // because a sibling field failed.
      setBaseline(saved);
      setValues({
        withdrawal: bpsToX(saved.withdrawal),
        leaderboard: bpsToX(saved.leaderboard),
        rakeback: bpsToX(saved.rakeback),
      });

      if (failures.length === 0) {
        toast.success("Keno weights updated");
      } else {
        toast.error(failures.join(" · "));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Keno Settings</CardTitle>
        <CardDescription>
          Every admin-editable keno weight in one place — the same keys the
          Withdrawal, Leaderboard and Rakeback systems use for the other
          games, gathered here by game instead of by destination. Values are
          multipliers (1× = 10000 bps). Saving writes through the backend,
          which validates and refreshes its own cache.
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
            claims. Keno&apos;s grid, pick range, bet limits and payout tables
            are fixed in the backend and are not editable here.
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
            // A single endpoint being down shouldn't block the other two.
            const unavailable = baseline[f.key] === undefined;
            return (
              <div key={f.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`keno-${f.key}`}>{f.label} (×)</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint}
                  </span>
                </div>
                <Input
                  id={`keno-${f.key}`}
                  type="number"
                  step="0.05"
                  min="0"
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
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
      </CardContent>
    </Card>
  );
}
