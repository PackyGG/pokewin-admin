"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, SlidersHorizontal, ArrowRight, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  planPackRetune,
  authorizePackRetune,
  applyPackRetune,
  type PackRetunePlan,
  type PackRetuneTargets,
} from "@/app/(admin)/packs/actions";
import {
  getPackRetunePool,
  type RetunePool,
} from "./retune-actions";

/**
 * Per-pack re-tune drawer (owner-only). Opens for ONE pack, shows its card pool
 * + current `computePackRisk` breakdown, lets the operator set the retune levers
 * (target edge / win-rate / max-win cap / near-miss floor), runs a READ-ONLY
 * `planPackRetune` preview (before→after edge/winRate/nearMiss/maxWin + the
 * per-card weight diff + any feasibility error), then gates the WRITE behind a
 * type-to-confirm phrase + a 2FA code (`authorizePackRetune` → `applyPackRetune`).
 *
 * House-POV coloring: edge ≥ target = emerald (healthy house margin); below =
 * rose (house giving away margin). Win-rate climbing = the player wins more =
 * rose-leaning. Mirrors the doctor table's read.
 *
 * Mirrors the `RepriceAllPacksButton` flow (dry-run → type-to-confirm → 2FA →
 * stoppable progress) but for a single pack's ODDS rewrite, delegating every
 * authoritative step to the existing paranoid pack server actions.
 */

const CONFIRM_PHRASE = "RETUNE";

type Phase = "loading" | "idle" | "planning" | "planned" | "applying" | "done";

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

/** Parse a percent string ("10.99") to a fraction (0.1099), or null if invalid. */
function parsePct(raw: string): number | null {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** Parse a USD string to a positive number, or null when blank/invalid. */
function parseUsd(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function RetuneDrawer({
  packId,
  open,
  onOpenChange,
}: {
  packId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [pool, setPool] = React.useState<RetunePool | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Retune levers (percent strings for edge/win-rate/near-miss, USD for cap).
  const [targetEdgePct, setTargetEdgePct] = React.useState("10.99");
  const [targetWinRatePct, setTargetWinRatePct] = React.useState("20");
  const [nearMissMinPct, setNearMissMinPct] = React.useState("10");

  // Max-win cap is auto by default (server fills it from autoRetuneTargets(price)).
  // The auto value is pulled from the pool (`pool.maxWinCap`) and shown read-only.
  // An optional, collapsed override lets the owner pin a custom cap — default off.
  const [capOverride, setCapOverride] = React.useState(false);
  const [maxWinCapUsd, setMaxWinCapUsd] = React.useState("");

  const [plan, setPlan] = React.useState<PackRetunePlan | null>(null);
  const [confirmText, setConfirmText] = React.useState("");
  const [totp, setTotp] = React.useState("");

  // (Re)load the pool whenever the drawer opens for a (new) pack.
  React.useEffect(() => {
    if (!open || !packId) return;
    let cancelled = false;
    setPhase("loading");
    setPool(null);
    setLoadError(null);
    setPlan(null);
    setConfirmText("");
    setTotp("");
    setCapOverride(false);
    (async () => {
      try {
        const p = await getPackRetunePool(packId);
        if (cancelled) return;
        setPool(p);
        // Seed the (collapsed) override field from the auto cap so, if the owner
        // flips override on, it starts from the auto value they'd otherwise get.
        setMaxWinCapUsd(String(p.maxWinCap));
        // Seed the win-rate lever from the pack's current win-rate so the first
        // preview is a near-no-op the operator can nudge from.
        setTargetWinRatePct((p.risk.winRate * 100).toFixed(0));
        setPhase("idle");
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load the pack pool.");
        setPhase("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, packId]);

  const targetEdge = parsePct(targetEdgePct);
  const targetWinRate = parsePct(targetWinRatePct);
  const maxWinCap = parseUsd(maxWinCapUsd);
  const nearMissMin = parsePct(nearMissMinPct);

  // The cap only constrains the plan when the owner explicitly overrides it.
  // Otherwise it stays undefined and the server fills the auto cap.
  const overrideCapValid = !capOverride || maxWinCap != null;

  const targetsValid =
    targetEdge != null &&
    targetEdge > 0 &&
    targetEdge < 1 &&
    targetWinRate != null &&
    targetWinRate >= 0 &&
    targetWinRate < 1 &&
    overrideCapValid &&
    nearMissMin != null &&
    nearMissMin >= 0 &&
    nearMissMin < 1;

  function buildTargets(): PackRetuneTargets {
    return {
      targetEdge: targetEdge ?? undefined,
      targetWinRate: targetWinRate!,
      // Omit the cap unless overriding → server defaults to the auto cap.
      maxWinCap: capOverride ? (maxWinCap ?? undefined) : undefined,
      nearMissMin: nearMissMin ?? undefined,
    };
  }

  async function runPlan() {
    if (!packId || !targetsValid) {
      toast.error("Enter valid retune targets first.");
      return;
    }
    setPhase("planning");
    setPlan(null);
    setConfirmText("");
    setTotp("");
    try {
      const result = await planPackRetune(packId, buildTargets());
      setPlan(result);
      setPhase("planned");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to plan the re-tune.");
      setPhase("idle");
    }
  }

  const totpValid = /^\d{6}$/.test(totp.trim());
  const applyReady =
    phase === "planned" &&
    plan?.feasible === true &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    totpValid;

  async function runApply() {
    if (!packId || !applyReady) return;
    setPhase("applying");
    let token: string;
    try {
      const res = await authorizePackRetune(totp.trim());
      token = res.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed.");
      setPhase("planned");
      return;
    }
    try {
      const res = await applyPackRetune(packId, token, buildTargets());
      setPhase("done");
      toast.success(
        `Re-tuned ${res.name}: edge ${pct(res.after.edge)} · win ${pct(res.after.winRate)}.`,
      );
      router.refresh();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-tune failed.");
      setPhase("planned");
    }
  }

  const busy = phase === "planning" || phase === "applying";

  return (
    <Sheet open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4" />
            Re-tune {pool?.name ?? "pack"}
          </SheetTitle>
          <SheetDescription>
            Rewrites this pack&apos;s per-card <strong>odds</strong> to hit the targets
            below. Preview the change, then type{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{CONFIRM_PHRASE}</code>{" "}
            and your 2FA code to apply. Card values + price are never touched.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 px-4 pb-4 text-sm">
          {phase === "loading" && (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading card pool…
            </div>
          )}

          {loadError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {loadError}
            </div>
          )}

          {pool && phase !== "loading" && (
            <>
              {/* Current risk breakdown */}
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Current risk · {formatCurrency(pool.price)} · {pool.cards.length} cards
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <RiskTile
                    label="Edge"
                    value={pct(pool.risk.edge)}
                    tone={pool.risk.edge >= (targetEdge ?? 0.1099) ? "emerald" : "rose"}
                  />
                  <RiskTile label="Win rate" value={pct(pool.risk.winRate)} />
                  <RiskTile label="Near-miss" value={pct(pool.risk.nearMiss)} />
                  <RiskTile label="Max win" value={formatCurrency(pool.risk.maxWin)} />
                  <RiskTile label="Max mult" value={`${formatNumber(pool.risk.maxMult)}×`} />
                  <RiskTile label="CV" value={pool.risk.cv.toFixed(2)} />
                </div>
              </div>

              <Separator />

              {/* Retune levers */}
              <div className="grid grid-cols-2 gap-3">
                <LeverInput
                  id="rt-edge"
                  label="Target edge (%)"
                  value={targetEdgePct}
                  onChange={setTargetEdgePct}
                  invalid={targetEdge == null || targetEdge <= 0 || targetEdge >= 1}
                />
                <LeverInput
                  id="rt-win"
                  label="Target win-rate (%)"
                  value={targetWinRatePct}
                  onChange={setTargetWinRatePct}
                  invalid={
                    targetWinRate == null || targetWinRate < 0 || targetWinRate >= 1
                  }
                />
                <LeverInput
                  id="rt-nm"
                  label="Near-miss floor (%)"
                  value={nearMissMinPct}
                  onChange={setNearMissMinPct}
                  invalid={nearMissMin == null || nearMissMin < 0 || nearMissMin >= 1}
                />
              </div>

              {/* Max-win cap — auto by default (server fills it from the price).
                  Shown read-only; an optional collapsed override pins a custom cap. */}
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Max-win cap (auto):{" "}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(pool.maxWinCap)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setCapOverride((v) => !v)}
                    disabled={busy}
                    className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    {capOverride ? "Use auto" : "Override"}
                  </button>
                </div>
                {capOverride && (
                  <div className="mt-2">
                    <LeverInput
                      id="rt-cap"
                      label="Custom max-win cap ($)"
                      value={maxWinCapUsd}
                      onChange={setMaxWinCapUsd}
                      invalid={maxWinCap == null}
                    />
                  </div>
                )}
              </div>

              <Button
                onClick={runPlan}
                disabled={!targetsValid || busy}
                variant="outline"
                className="w-full"
              >
                {phase === "planning" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <SlidersHorizontal className="size-4" />
                )}
                Plan re-tune
              </Button>

              {/* Plan result */}
              {plan && phase !== "planning" && (
                <PlanPreview plan={plan} targetEdge={targetEdge ?? 0.1099} />
              )}

              {/* Card pool */}
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Card pool ({pool.cards.length})
                </summary>
                <div className="max-h-56 overflow-y-auto border-t">
                  {pool.cards.map((c) => {
                    const diff = plan?.weightDiff.find((d) => d.cardId === c.cardId);
                    return (
                      <div
                        key={c.cardId}
                        className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {formatCurrency(c.value)}
                        </span>
                        <span className="flex w-28 shrink-0 items-center justify-end gap-1 tabular-nums">
                          {diff ? (
                            <>
                              <span className="text-muted-foreground">{diff.from}</span>
                              <ArrowRight className="size-3 text-muted-foreground" />
                              <span className="font-medium">{diff.to}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">w {c.weight}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </details>

              {/* Confirm + 2FA (only once a feasible plan exists) */}
              {plan?.feasible && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="rt-confirm">Type {CONFIRM_PHRASE} to confirm</Label>
                      <Input
                        id="rt-confirm"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={CONFIRM_PHRASE}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="rt-totp">2FA code</Label>
                      <Input
                        id="rt-totp"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={totp}
                        onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                        placeholder="123456"
                        className="w-40 tracking-[0.3em]"
                        aria-invalid={totp.length > 0 && !totpValid}
                        disabled={busy}
                      />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button onClick={runApply} disabled={!applyReady} className="w-full sm:w-auto">
            {phase === "applying" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Apply re-tune"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RiskTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose";
}) {
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
      <p
        className={cn(
          "text-sm font-semibold tabular-nums leading-none",
          tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
          tone === "rose" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function LeverInput({
  id,
  label,
  value,
  onChange,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className="h-8"
      />
    </div>
  );
}

/**
 * Before→after risk preview + feasibility. House-POV: an edge moving toward /
 * above target reads emerald; below reads rose. The win-rate / near-miss / max-
 * win rows just show the delta direction.
 */
function PlanPreview({
  plan,
  targetEdge,
}: {
  plan: PackRetunePlan;
  targetEdge: number;
}) {
  if (!plan.feasible || !plan.after) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>
          <span className="font-medium">Infeasible:</span>{" "}
          {plan.error ?? "This pool can't hit the requested targets."}
        </span>
      </div>
    );
  }
  const before = plan.before;
  const after = plan.after;
  const rows: { label: string; before: string; after: string; afterTone?: "emerald" | "rose" }[] = [
    {
      label: "Edge",
      before: pct(before.edge),
      after: pct(after.edge),
      afterTone: after.edge >= targetEdge ? "emerald" : "rose",
    },
    { label: "Win rate", before: pct(before.winRate), after: pct(after.winRate) },
    { label: "Near-miss", before: pct(before.nearMiss), after: pct(after.nearMiss) },
    {
      label: "Max win",
      before: formatCurrency(before.maxWin),
      after: formatCurrency(after.maxWin),
    },
  ];
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Re-tune preview
        </span>
        <Badge
          variant="outline"
          className="h-5 border-emerald-500/30 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
        >
          Feasible · {plan.weightDiff.length} cards change
        </Badge>
      </div>
      <div className="divide-y">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
          >
            <span className="text-muted-foreground">{r.label}</span>
            <span className="flex items-center gap-1.5 tabular-nums">
              <span className="text-muted-foreground">{r.before}</span>
              <ArrowRight className="size-3 text-muted-foreground" />
              <span
                className={cn(
                  "font-medium",
                  r.afterTone === "emerald" && "text-emerald-600 dark:text-emerald-400",
                  r.afterTone === "rose" && "text-rose-600 dark:text-rose-400",
                )}
              >
                {r.after}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
