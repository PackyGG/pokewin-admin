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
import { updateWagerRequirementDefaultsAction } from "./wager-requirement-actions";
import type { WagerRequirementDefaults } from "@/lib/backend-api/wager-requirements";

/**
 * Site-wide withdrawal wager-requirement defaults editor.
 *
 * Every knob is stored on the backend in basis points (10000 bps = 1×),
 * but admins think in multipliers, so the form is in ×-multipliers with a
 * live "= N bps" hint. On save we convert × → bps (Math.round(x * 10000),
 * clamped 0..1_000_000) and send ONLY the changed fields, so the audit
 * event records exactly what moved.
 *
 * `initial === null` means the backend read failed (the wager-requirement
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable inputs rather than crashing /security.
 */

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

type FieldKey = keyof WagerRequirementDefaults;

const FIELDS: {
  key: FieldKey;
  label: string;
  help: React.ReactNode;
}[] = [
  {
    key: "wager_requirement_bps",
    label: "Deposit requirement",
    help: (
      <>
        Multiplier frozen onto each deposit when it lands — the user must wager
        the deposited amount × this before that deposit can be withdrawn.
        Applied per deposit, not on a lifetime total; editing it only affects
        future deposits. Default 1×. <code>0×</code> disables the deposit
        requirement entirely.
      </>
    ),
  },
  {
    key: "bonus_wager_requirement_bps",
    label: "Bonus-winnings requirement",
    help: (
      <>
        Multiplier frozen onto each general bonus credit (rain, prizes,
        rewards, sponsored battles) when it&apos;s awarded. Applied per credit,
        not on a lifetime total; editing it only affects future credits.
        Default 1×. <code>0×</code> disables it. Rakeback and tips have their
        own requirements below; affiliate claims are configured on Creator
        Settings.
      </>
    ),
  },
  {
    key: "admin_adjustment_wager_requirement_bps",
    label: "Admin-adjustment requirement",
    help: (
      <>
        Multiplier frozen onto each admin balance credit (giveaways, bonuses,
        manual adjustments). 1× means a credited user must wager the credited
        amount once before that money can be withdrawn. Applied per credit (not
        lifetime). Default 1×. <code>0×</code> makes admin credits instantly
        withdrawable.
      </>
    ),
  },
  {
    key: "affiliate_leaderboard_wager_requirement_bps",
    label: "Affiliate-leaderboard requirement",
    help: (
      <>
        Multiplier frozen onto each affiliate leaderboard prize when it&apos;s
        claimed. Applied per claim, not on a lifetime total; editing it only
        affects future claims. Default 1×. <code>0×</code> lets winners
        withdraw their prize immediately.
      </>
    ),
  },
  {
    key: "rakeback_wager_requirement_bps",
    label: "Rakeback requirement",
    help: (
      <>
        Multiplier frozen onto each rakeback claim when it&apos;s claimed.
        Applied per claim, not on a lifetime total; editing it only affects
        future claims. Default 1×. <code>0×</code> disables it.
      </>
    ),
  },
  {
    key: "tips_wager_requirement_bps",
    label: "Tips requirement",
    help: (
      <>
        Multiplier frozen onto each tip when it&apos;s received. Applied per
        tip, not on a lifetime total; editing it only affects future tips.
        Default 1×. <code>0×</code> disables it.
      </>
    ),
  },
  {
    key: "wager_weight_packs_bps",
    label: "Packs wager weight",
    help: (
      <>
        How much pack wagers count toward the requirement. Default 1× — a
        $100 pack wager adds $100 of progress.
      </>
    ),
  },
  {
    key: "wager_weight_battles_bps",
    label: "Battles wager weight",
    help: (
      <>
        How much battle wagers count toward the requirement. Default 1× — a
        $100 battle wager adds $100 of progress.
      </>
    ),
  },
  {
    key: "wager_weight_upgrader_bps",
    label: "Upgrader wager weight",
    help: (
      <>
        How much upgrader wagers count toward the requirement. Default 0.8× —
        a $100 upgrader bet adds only $80 of progress.
      </>
    ),
  },
  // Keno is deliberately absent: it is edited in Content → Keno, so
  // wager_weight_keno_bps has exactly one editable surface.
];

// Tolerates a field the backend hasn't shipped yet (e.g. wager_weight_keno_bps
// against an older deploy): an absent value seeds an EMPTY input rather than
// "NaN", and handleSave's `raw === ""` guard then leaves it untouched unless an
// admin actually types a value.
function bpsToX(bps: number | undefined): string {
  return typeof bps === "number" ? String(bps / BPS_PER_X) : "";
}

export function WagerRequirementCard({
  initial,
}: {
  initial: WagerRequirementDefaults | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Server-truth baseline for dirty-tracking. Seeded from the initial prop and
  // re-baselined to the saved defaults after a successful write, so the card
  // reflects the saved values in place WITHOUT a router.refresh() (no scroll
  // jump). Re-editing then diffs against what was actually persisted.
  const [baseline, setBaseline] = useState<WagerRequirementDefaults | null>(
    initial,
  );

  // Form state: one ×-multiplier string per field. Missing response keys stay
  // empty and disabled; inventing a 1× fallback would present an unconfirmed
  // backend value as live configuration.
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
            Withdrawal Wager Requirements
          </CardTitle>
          <CardDescription>
            Site-wide defaults for the withdrawal wager requirement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The withdrawal wager-requirement endpoints aren&apos;t
                reachable on the current backend deploy. This card becomes
                editable once the feature ships to the backend.
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
  const unavailableFields = FIELDS.filter(
    (field) => typeof base[field.key] !== "number",
  );

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
      const result = await updateWagerRequirementDefaultsAction(payload);
      if (result.success) {
        toast.success("Wager requirement defaults updated");
        // Re-baseline to the saved defaults in place — no router.refresh(), so
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
          Withdrawal Wager Requirements
        </CardTitle>
        <CardDescription>
          Site-wide defaults applied to NEW credits. Each deposit, bonus, claim
          or tip freezes its own requirement at the moment it&apos;s credited —
          these knobs only affect future credits, never requirements already
          frozen. Values are multipliers (1× = 10000 bps). Saving writes through
          the backend, which validates and refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Each credit freezes amount × its multiplier into the user&apos;s
            wager debt at credit time; real wagers burn that debt down, and
            withdrawal is a partial lock (withdrawable = balance − remaining
            debt). Editing a knob reprices only future credits, never debt
            already frozen. Per-game weights scale how much each wager counts
            toward burning it down. Per-user overrides live on the user detail
            page.
          </p>
        </div>

        {unavailableFields.length > 0 && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              The selected backend did not return{" "}
              {unavailableFields.map((field) => field.label).join(", ")}. Those
              controls are disabled instead of assuming a value.
            </p>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {FIELDS.map((f) => {
            const available = typeof base[f.key] === "number";
            const raw = values[f.key].trim();
            const x = raw === "" ? null : Number(raw);
            const bpsHint =
              x !== null && Number.isFinite(x) && x >= 0
                ? `= ${Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))} bps`
                : "= — bps";
            return (
              <div key={f.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`wr-${f.key}`}>{f.label} (×)</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint}
                  </span>
                </div>
                <Input
                  id={`wr-${f.key}`}
                  type="number"
                  step="0.05"
                  min="0"
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  disabled={isPending || !available}
                  placeholder={available ? undefined : "Not returned by backend"}
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
