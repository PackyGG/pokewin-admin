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
import { updateRewardExpiryAction } from "./reward-expiry-actions";
import type {
  RewardExpiry,
  UpdateRewardExpiryInput,
} from "@/lib/backend-api/reward-expiry";

/**
 * Reward claim-window editor — how many days each reward type stays
 * claimable after its anchor event. 0 = never expires.
 *
 * Values are whole days (not bps — unlike the weight cards above): e.g.
 * rakeback 3 = each rakeback period stays claimable 3 days after it ends;
 * race 7 = race prizes stay claimable 7 days after the race ends. On save we
 * send ONLY the changed fields, so the audit event records exactly what
 * moved.
 *
 * Rakeback is per-type (daily/weekly/monthly — backend rakeback_config
 * table, enforcement pre-exists); race / leaderboard / balance windows are
 * site_config keys whose claim-time enforcement ships with the same backend
 * branch as the /admin/reward-expiry endpoints.
 *
 * `initial === null` means the backend read failed (the reward-expiry
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state with no editable inputs rather than crashing /security.
 */

const MAX_DAYS = 3650;

type FieldDef = {
  /** Flat form key, also used for input ids. */
  key: string;
  label: string;
  /** Read the current value from the GET payload. */
  read: (e: RewardExpiry) => number;
  /** Write a changed value into the PUT payload. */
  write: (p: UpdateRewardExpiryInput, days: number) => void;
};

type GroupDef = {
  title: string;
  help: React.ReactNode;
  fields: FieldDef[];
};

const GROUPS: GroupDef[] = [
  {
    title: "Rakeback",
    help: (
      <>
        Days after each rakeback period ends that its claim stays available.
        Per period type — e.g. daily 3 = each day&apos;s rakeback is claimable
        for 3 days after that day ends.
      </>
    ),
    fields: [
      {
        key: "rakeback.daily",
        label: "Daily",
        read: (e) => e.rakeback.daily_days,
        write: (p, d) => {
          (p.rakeback ??= {}).daily_days = d;
        },
      },
      {
        key: "rakeback.weekly",
        label: "Weekly",
        read: (e) => e.rakeback.weekly_days,
        write: (p, d) => {
          (p.rakeback ??= {}).weekly_days = d;
        },
      },
      {
        key: "rakeback.monthly",
        label: "Monthly",
        read: (e) => e.rakeback.monthly_days,
        write: (p, d) => {
          (p.rakeback ??= {}).monthly_days = d;
        },
      },
    ],
  },
  {
    title: "Race winnings",
    help: (
      <>
        Days after a race period ends that its prizes stay claimable.
        Enforced at claim time — already-claimed prizes are never re-touched.
      </>
    ),
    fields: [
      {
        key: "race",
        label: "Race prizes",
        read: (e) => e.race_days,
        write: (p, d) => {
          p.race_days = d;
        },
      },
    ],
  },
  {
    title: "Leaderboards",
    help: (
      <>
        Days after a creator/affiliate leaderboard ends that its prizes stay
        claimable.
      </>
    ),
    fields: [
      {
        key: "leaderboard",
        label: "Leaderboard prizes",
        read: (e) => e.leaderboard_days,
        write: (p, d) => {
          p.leaderboard_days = d;
        },
      },
    ],
  },
  {
    title: "Reloads & balance rewards",
    help: (
      <>
        Days after a balance reward (reload / bonus / deposit-fix / giveaway /
        lossback) is granted that it stays claimable.
      </>
    ),
    fields: [
      {
        key: "balance",
        label: "Balance rewards",
        read: (e) => e.balance_days,
        write: (p, d) => {
          p.balance_days = d;
        },
      },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

export function RewardExpiryCard({
  initial,
}: {
  initial: RewardExpiry | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Form state: one day-count string per field. Seeded from the initial
  // values. Hooks must run unconditionally, so this is declared even when
  // initial is null (the degraded branch returns before using it).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of ALL_FIELDS) {
      seed[f.key] = initial ? String(f.read(initial)) : "";
    }
    return seed;
  });

  if (!initial) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Reward Expiry</CardTitle>
          <CardDescription>
            Claim windows per reward type — how many days rakeback, race
            winnings, leaderboard prizes and balance rewards stay claimable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The reward-expiry endpoints aren&apos;t reachable on the
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
    const payload: UpdateRewardExpiryInput = {};
    let changed = false;

    for (const f of ALL_FIELDS) {
      const raw = values[f.key].trim();
      if (raw === "") continue; // empty → leave unchanged
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_DAYS) {
        toast.error(
          `${f.label}: must be a whole number of days between 0 and ${MAX_DAYS}`,
        );
        return;
      }
      if (n !== f.read(initial)) {
        f.write(payload, n);
        changed = true;
      }
    }

    if (!changed) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateRewardExpiryAction(payload);
      if (result.success) {
        toast.success("Reward expiry updated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Reward Expiry</CardTitle>
        <CardDescription>
          How many days each reward type stays claimable after its anchor
          event (rakeback/race/leaderboard: after the period ends; balance
          rewards: after the reward is granted). Values are whole days;{" "}
          <code>0</code> = never expires. Saving writes through the backend,
          which validates and refreshes its own cache.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            Windows are enforced at claim time — changes apply to future claim
            attempts immediately, and already-claimed prizes are never
            re-touched. Shrinking a window can make currently-claimable prizes
            unclaimable on the next attempt.
          </p>
        </div>

        {GROUPS.map((g) => (
          <div key={g.title} className="space-y-3">
            <div>
              <h4 className="text-sm font-medium">{g.title}</h4>
              <p className="text-[11px] text-muted-foreground">{g.help}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.fields.map((f) => {
                const raw = values[f.key].trim();
                const n = raw === "" ? null : Number(raw);
                const hint =
                  n === null || !Number.isInteger(n) || n < 0
                    ? ""
                    : n === 0
                      ? "never expires"
                      : `expires after ${n} day${n === 1 ? "" : "s"}`;
                return (
                  <div key={f.key} className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`rex-${f.key}`}>{f.label} (days)</Label>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {hint}
                      </span>
                    </div>
                    <Input
                      id={`rex-${f.key}`}
                      type="number"
                      step="1"
                      min="0"
                      max={MAX_DAYS}
                      value={values[f.key]}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [f.key]: e.target.value,
                        }))
                      }
                      disabled={isPending}
                    />
                  </div>
                );
              })}
            </div>
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
