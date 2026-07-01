"use client";

/**
 * Per-user withdrawal wager-requirement overrides.
 *
 * Shows a table of all 7 credit sources, each with its own per-user override.
 * null = no override (uses site-wide global). 0 = exempt for that source.
 * 10000 bps = 1× requirement.
 *
 * Admin-only — the underlying actions use requireAdmin(). Non-admins
 * (canManage=false) see read-only status with no buttons.
 *
 * `data === null` means the backend read failed (the wager-requirement
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state rather than crashing the Account tab.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  setUserWagerRequirementAction,
  clearUserWagerRequirementAction,
} from "./wager-requirement-actions";
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

function formatX(bps: number): string {
  return `${bps / BPS_PER_X}×`;
}

function overrideCellLabel(bps: number | null): string {
  if (bps === null) return "uses global";
  if (bps === 0) return "EXEMPT (0×)";
  return `${formatX(bps)} (${bps} bps)`;
}

type SourceRow = {
  label: string;
  globalDefault: number | null; // null = not returned by API for this source
  override: number | null;
};

function buildRows(data: UserWagerRequirement): SourceRow[] {
  return [
    {
      label: "Deposit",
      globalDefault: data.default_wager_requirement_bps,
      override: data.wager_requirement_bps,
    },
    {
      label: "Bonus / Leaderboard",
      globalDefault: null,
      override: data.bonus_wager_requirement_bps,
    },
    {
      label: "Affiliate claims",
      globalDefault: null,
      override: data.affiliate_wager_requirement_bps,
    },
    {
      label: "Affiliate leaderboard",
      globalDefault: null,
      override: data.affiliate_leaderboard_wager_requirement_bps,
    },
    {
      label: "Rakeback claims",
      globalDefault: null,
      override: data.rakeback_wager_requirement_bps,
    },
    {
      label: "Tips received",
      globalDefault: null,
      override: data.tips_wager_requirement_bps,
    },
    {
      label: "Admin adjustments",
      globalDefault: null,
      override: data.admin_adjustment_wager_requirement_bps,
    },
  ];
}

export function UserWagerRequirementCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: UserWagerRequirement | null;
  canManage: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Optimistic, locally-tracked overrides. Seeded from the `data` prop and
  // updated in place on a successful Save / Clear so the table flips instantly
  // WITHOUT a `router.refresh()` (which would re-suspend the page and lose the
  // admin's scroll — see use-toggle-action.ts). The override bps are stored
  // verbatim by the backend, so the optimistic value is authoritative. Re-synced
  // to the prop whenever the narrow `users-detail-${userId}` revalidation
  // streams a fresh value in (never while a mutation is mid-flight).
  const [localData, setLocalData] = useState<UserWagerRequirement | null>(data);
  useEffect(() => {
    if (isPending) return;
    setLocalData(data);
  }, [data, isPending]);

  if (!localData) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The withdrawal wager-requirement endpoints aren&apos;t
                reachable on the current backend deploy. Per-user overrides
                become available once the feature ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const rows = buildRows(localData);
  const hasAnyOverride = rows.some((r) => r.override !== null);

  const handleClear = () => {
    // Snapshot for rollback on failure.
    const before = localData;
    startTransition(async () => {
      const result = await clearUserWagerRequirementAction(userId);
      if (result.success) {
        // Cleared → all per-user overrides drop to null (user falls back to
        // the site-wide global for every source). Update in place, no refresh.
        setLocalData({
          ...before,
          wager_requirement_bps: null,
          bonus_wager_requirement_bps: null,
          affiliate_wager_requirement_bps: null,
          affiliate_leaderboard_wager_requirement_bps: null,
          rakeback_wager_requirement_bps: null,
          tips_wager_requirement_bps: null,
          admin_adjustment_wager_requirement_bps: null,
          effective_wager_requirement_bps: before.default_wager_requirement_bps,
        });
        toast.success("Override removed — user falls back to the default");
      } else {
        setLocalData(before);
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {/* Source table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left font-medium text-muted-foreground pb-2 pr-4">
                  Source
                </th>
                <th className="text-left font-medium text-muted-foreground pb-2 pr-4">
                  Global default
                </th>
                <th className="text-left font-medium text-muted-foreground pb-2 pr-4">
                  Your override
                </th>
                <th className="text-left font-medium text-muted-foreground pb-2">
                  Effective
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => {
                const effective =
                  row.override !== null
                    ? row.override
                    : row.globalDefault ?? null;
                return (
                  <tr key={row.label}>
                    <td className="py-2 pr-4 font-medium text-foreground">
                      {row.label}
                    </td>
                    <td className="py-2 pr-4 tabular-nums text-muted-foreground">
                      {row.globalDefault !== null
                        ? `${formatX(row.globalDefault)} (${row.globalDefault} bps)`
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {row.override !== null ? (
                        <span className="font-medium text-foreground">
                          {overrideCellLabel(row.override)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          uses global
                        </span>
                      )}
                    </td>
                    <td className="py-2 tabular-nums text-muted-foreground">
                      {effective !== null
                        ? `${formatX(effective)} (${effective} bps)`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Each source can be overridden independently.{" "}
          <code className="font-mono">0×</code> fully exempts the user for that
          source. Leaving an override blank means the user follows the
          site-wide global setting for that source.
        </p>

        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              {hasAnyOverride ? "Edit overrides" : "Set custom overrides"}
            </Button>
            {hasAnyOverride && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClear}
                disabled={isPending}
              >
                {isPending ? "Working…" : "Clear all overrides"}
              </Button>
            )}
          </div>
        )}

        <UserWagerRequirementDialog
          userId={userId}
          data={localData}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSaved={setLocalData}
        />
      </CardContent>
    </Card>
  );
}

type FieldKey =
  | "wager_requirement_bps"
  | "bonus_wager_requirement_bps"
  | "affiliate_wager_requirement_bps"
  | "affiliate_leaderboard_wager_requirement_bps"
  | "rakeback_wager_requirement_bps"
  | "tips_wager_requirement_bps"
  | "admin_adjustment_wager_requirement_bps";

type FormValues = Record<FieldKey, string>;

// Seed the input from stored bps as a ×-multiplier (admins think in ×).
function bpsToInputValue(bps: number | null): string {
  if (bps === null) return "";
  return String(bps / BPS_PER_X);
}

// Parse a ×-multiplier input into bps for the backend.
//   undefined = blank → omit from payload (user keeps the global default)
//   null      = invalid (non-numeric / negative) → caller surfaces an error
//   number    = bps (multiplier × 10000, clamped 0..MAX_BPS)
function inputValueToBps(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const x = Number(trimmed);
  if (!Number.isFinite(x) || x < 0) return null;
  return Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));
}

// Live "= N bps" hint shown next to a multiplier input.
function bpsHint(raw: string): string {
  const bps = inputValueToBps(raw);
  if (bps === undefined) return "= use global";
  if (bps === null) return "= — bps";
  return `= ${bps} bps`;
}

function UserWagerRequirementDialog({
  userId,
  data,
  open,
  onOpenChange,
  onSaved,
}: {
  userId: string;
  data: UserWagerRequirement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Push the just-saved config up so the card reflects it optimistically —
  // no `router.refresh()`. Only the fields the admin actually entered are
  // merged (blank = "keep global" = untouched), matching the backend, which
  // only updates the sent fields.
  onSaved: (next: UserWagerRequirement) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => ({
    wager_requirement_bps: bpsToInputValue(data.wager_requirement_bps),
    bonus_wager_requirement_bps: bpsToInputValue(data.bonus_wager_requirement_bps),
    affiliate_wager_requirement_bps: bpsToInputValue(data.affiliate_wager_requirement_bps),
    affiliate_leaderboard_wager_requirement_bps: bpsToInputValue(
      data.affiliate_leaderboard_wager_requirement_bps,
    ),
    rakeback_wager_requirement_bps: bpsToInputValue(data.rakeback_wager_requirement_bps),
    tips_wager_requirement_bps: bpsToInputValue(data.tips_wager_requirement_bps),
    admin_adjustment_wager_requirement_bps: bpsToInputValue(
      data.admin_adjustment_wager_requirement_bps,
    ),
  }));
  const [isPending, startTransition] = useTransition();

  // Reset the form whenever the dialog re-opens.
  useEffect(() => {
    if (open) {
      setValues({
        wager_requirement_bps: bpsToInputValue(data.wager_requirement_bps),
        bonus_wager_requirement_bps: bpsToInputValue(data.bonus_wager_requirement_bps),
        affiliate_wager_requirement_bps: bpsToInputValue(
          data.affiliate_wager_requirement_bps,
        ),
        affiliate_leaderboard_wager_requirement_bps: bpsToInputValue(
          data.affiliate_leaderboard_wager_requirement_bps,
        ),
        rakeback_wager_requirement_bps: bpsToInputValue(
          data.rakeback_wager_requirement_bps,
        ),
        tips_wager_requirement_bps: bpsToInputValue(data.tips_wager_requirement_bps),
        admin_adjustment_wager_requirement_bps: bpsToInputValue(
          data.admin_adjustment_wager_requirement_bps,
        ),
      });
    }
  }, [open, data]);

  const setField = (key: FieldKey, val: string) =>
    setValues((prev) => ({ ...prev, [key]: val }));

  const handleSave = () => {
    // Each field is a ×-multiplier. Parse → bps; blank = omit (keep global),
    // invalid = error. "Clear all overrides" (separate button) handles reset,
    // so we never send an explicit null from here.
    const allFields: { key: FieldKey; label: string }[] = [
      { key: "wager_requirement_bps", label: "Deposit" },
      { key: "bonus_wager_requirement_bps", label: "Bonus / Leaderboard" },
      { key: "affiliate_wager_requirement_bps", label: "Affiliate claims" },
      {
        key: "affiliate_leaderboard_wager_requirement_bps",
        label: "Affiliate leaderboard",
      },
      { key: "rakeback_wager_requirement_bps", label: "Rakeback claims" },
      { key: "tips_wager_requirement_bps", label: "Tips received" },
      {
        key: "admin_adjustment_wager_requirement_bps",
        label: "Admin adjustments",
      },
    ];

    const payload: Parameters<typeof setUserWagerRequirementAction>[0] = {
      userId,
    };
    let hasAnyField = false;

    for (const f of allFields) {
      const bps = inputValueToBps(values[f.key]);
      if (bps === undefined) continue; // blank → keep the global default
      if (bps === null) {
        toast.error(`${f.label}: multiplier must be a non-negative number`);
        return;
      }
      payload[f.key] = bps;
      hasAnyField = true;
    }

    if (!hasAnyField) {
      toast.error("Enter at least one value to save");
      return;
    }

    startTransition(async () => {
      const result = await setUserWagerRequirementAction(payload);
      if (result.success) {
        // Merge ONLY the entered fields onto the current data — the backend
        // updates just the sent fields, so untouched overrides keep their
        // value. `payload` carries `userId` too; strip it before merging.
        const { userId: _userId, ...savedFields } = payload;
        void _userId;
        onSaved({ ...data, ...savedFields });
        toast.success("Wager requirement overrides saved");
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  type FieldSpec = { key: FieldKey; label: string };

  const depositField: FieldSpec = {
    key: "wager_requirement_bps",
    label: "Deposit",
  };

  const bonusFields: FieldSpec[] = [
    { key: "bonus_wager_requirement_bps", label: "Bonus / Leaderboard" },
    { key: "affiliate_wager_requirement_bps", label: "Affiliate claims" },
    {
      key: "affiliate_leaderboard_wager_requirement_bps",
      label: "Affiliate leaderboard",
    },
    { key: "rakeback_wager_requirement_bps", label: "Rakeback claims" },
    { key: "tips_wager_requirement_bps", label: "Tips received" },
    { key: "admin_adjustment_wager_requirement_bps", label: "Admin adjustments" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Custom Wager Requirements</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <p className="text-xs text-muted-foreground">
            Values are multipliers (×). Leave blank to use the site-wide global
            setting. Enter <code className="font-mono">0</code> to fully exempt.
            Enter <code className="font-mono">1</code> for 1× (the user must
            wager the credited amount once); <code className="font-mono">1.5</code>{" "}
            for 1.5×.
          </p>

          {/* Deposit section */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Deposit
            </p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={depositField.key} className="text-xs">
                  {depositField.label} (×)
                </Label>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {bpsHint(values[depositField.key])}
                </span>
              </div>
              <Input
                id={depositField.key}
                type="number"
                step="0.05"
                min="0"
                placeholder="e.g. 1 = 1×, 0 = exempt, blank = use global"
                value={values[depositField.key]}
                onChange={(e) => setField(depositField.key, e.target.value)}
              />
            </div>
          </div>

          {/* Bonus sources section */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Bonus Sources
            </p>
            {bonusFields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={f.key} className="text-xs">
                    {f.label} (×)
                  </Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {bpsHint(values[f.key])}
                  </span>
                </div>
                <Input
                  id={f.key}
                  type="number"
                  step="0.05"
                  min="0"
                  placeholder="e.g. 1 = 1×, 0 = exempt, blank = use global"
                  value={values[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
