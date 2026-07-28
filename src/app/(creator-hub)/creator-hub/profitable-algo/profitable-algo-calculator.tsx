"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Calculator,
  TrendingUp,
  Coins,
  CalendarDays,
  Info,
  CheckCircle2,
  XCircle,
  Wallet,
  Trophy,
  Gift,
  Crosshair,
  Copy,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { HOUSE_EDGE, LB_HOUSE_SHARE } from "@/lib/deal-economics";

/**
 * ROI Calculator (Creator Hub → Profitable Algo route).
 *
 * A PURE calculator: no DB, no server data, no API. The manager enters ONE
 * deal (spend legs + expected wager + frame length) and the tool evaluates it
 * with the canonical `@/lib/deal-economics` math:
 *
 *   Generated Value   = WAGER × HOUSE_EDGE                  (7.5%)
 *   Deal Spend        = WITHDRAW CAP + LB CONTRIBUTION + TIP/SPONSOR
 *   Rate of Return    = Generated Value / Deal Spend        (profitable > 1)
 *   Break-even Wager  = Deal Spend / HOUSE_EDGE             (same
 *                       `expectedWager` formula the Profitability page uses)
 *
 * Weekly/daily figures are DERIVED from the frame length (days) — the deal is
 * entered once, never twice at different periodicities.
 *
 * House-POV colors: generated value → emerald (value to the house), spend →
 * rose (house cost), neutral/derived → blue.
 *
 * Inputs mirror to the URL (`?wager=&cap=&lb=&tip=&days=`, debounced
 * `router.replace`) so a scenario is shareable; the server page parses them
 * back as initial state.
 */

/** "7.5%" — the house value rate as a display label, derived from the constant. */
const HOUSE_EDGE_PCT_LABEL = `${HOUSE_EDGE * 100}%`;

/** "50%" — the LB house share as a display label, derived from the constant. */
const LB_HOUSE_PCT_LABEL = `${LB_HOUSE_SHARE * 100}%`;

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Parse a currency-ish text input into a non-negative finite number.
 * Empty / invalid / negative → 0 so the math never produces NaN. We strip
 * commas and a leading "$" so paste-from-anywhere just works.
 */
function num(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Render a rate of return with 2 decimals + an ×; non-finite → "—". */
function formatRoR(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(2)}×`;
}

export type CalculatorInitialValues = {
  wager: string;
  cap: string;
  lb: string;
  tip: string;
  days: string;
};

const EMPTY_VALUES: CalculatorInitialValues = {
  wager: "",
  cap: "",
  lb: "",
  tip: "",
  days: "",
};

// ─── labelled input with hover help + unit adornment ───────────────

function FieldRow({
  id,
  label,
  help,
  value,
  onChange,
  placeholder,
  icon: Icon,
  iconColor,
  unit,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  icon: React.ElementType;
  iconColor: string;
  /** "$" renders a left prefix; "days" renders a right suffix. */
  unit: "$" | "days";
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", iconColor)} />
        <span className="min-w-0 truncate">{label}</span>
        {/* Hover help — tabIndex={-1} keeps the (i) out of the tab order so
            tabbing moves field → field, not field → tooltip → field. */}
        <Tooltip>
          <TooltipTrigger
            type="button"
            tabIndex={-1}
            aria-label={`About ${label}`}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[16rem]">
            {help}
          </TooltipContent>
        </Tooltip>
      </Label>
      <div className="relative">
        {unit === "$" && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
          >
            $
          </span>
        )}
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn("font-mono", unit === "$" ? "pl-7" : "pr-14")}
        />
        {unit === "days" && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
          >
            days
          </span>
        )}
      </div>
    </div>
  );
}

// ─── main calculator ───────────────────────────────────────────────

export function ProfitableAlgoCalculator({
  initial = EMPTY_VALUES,
}: {
  initial?: CalculatorInitialValues;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // ONE deal model — every figure below derives from these five inputs.
  const [wager, setWager] = React.useState(initial.wager);
  const [cap, setCap] = React.useState(initial.cap);
  const [lb, setLb] = React.useState(initial.lb);
  const [tip, setTip] = React.useState(initial.tip);
  const [days, setDays] = React.useState(initial.days);

  // ── URL sync (shareable scenarios) ── mirror inputs to query params,
  // debounced so typing doesn't spam history. `replace` + scroll:false keeps
  // it invisible; empty inputs drop their param entirely.
  const skipFirstSync = React.useRef(true);
  React.useEffect(() => {
    if (skipFirstSync.current) {
      skipFirstSync.current = false;
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (wager) params.set("wager", wager);
      if (cap) params.set("cap", cap);
      if (lb) params.set("lb", lb);
      if (tip) params.set("tip", tip);
      if (days) params.set("days", days);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 400);
    return () => clearTimeout(t);
  }, [wager, cap, lb, tip, days, pathname, router]);

  // ── Deal math (canonical: deal-economics constants) ──
  const wagerN = num(wager);
  const capN = num(cap);
  const lbN = num(lb);
  const tipN = num(tip);
  const daysN = num(days);

  const generatedValue = wagerN * HOUSE_EDGE;
  const dealSpend = capN + lbN + tipN;
  const hasSpend = dealSpend > 0;
  const net = generatedValue - dealSpend;
  const rateOfReturn = hasSpend ? generatedValue / dealSpend : Infinity;
  const profitable = hasSpend && rateOfReturn > 1;

  // Break-even solver — the same `expectedWager = dealCost / HOUSE_EDGE`
  // formula `computeDealCost` uses on the Profitability page.
  const breakEvenWager = hasSpend ? dealSpend / HOUSE_EDGE : 0;
  const wagerDelta = wagerN - breakEvenWager;

  // Derived weekly/daily views from the frame length. Zero days (or zero
  // wager for the value legs) → "—", never a misleading $0.00.
  const hasFrame = daysN > 0;
  const dailyValue = hasFrame ? generatedValue / daysN : 0;
  const weeklyValue = dailyValue * 7;
  const dailySpend = hasFrame ? dealSpend / daysN : 0;
  const weeklySpend = dailySpend * 7;
  const weeklyNet = weeklyValue - weeklySpend;

  const handleReset = React.useCallback(() => {
    setWager("");
    setCap("");
    setLb("");
    setTip("");
    setDays("");
  }, []);

  const handleCopySummary = React.useCallback(() => {
    const verdict = !hasSpend
      ? "No spend entered"
      : profitable
        ? "Profitable"
        : "Not profitable";
    const lines = [
      "ROI Calculator — deal summary",
      `Expected wager: ${wagerN > 0 ? formatCurrency(wagerN) : "—"}`,
      `Withdraw cap: ${formatCurrency(capN)}`,
      `LB contribution: ${formatCurrency(lbN)}`,
      `Tip/Sponsor allowance: ${formatCurrency(tipN)}`,
      `Frame length: ${hasFrame ? `${daysN} days` : "—"}`,
      "",
      `Generated value (wager × ${HOUSE_EDGE_PCT_LABEL}): ${formatCurrency(generatedValue)}`,
      `Deal spend: ${formatCurrency(dealSpend)}`,
      `Net: ${hasSpend || wagerN > 0 ? formatCurrency(net) : "—"}`,
      `Rate of return: ${hasSpend ? formatRoR(rateOfReturn) : "—"}`,
      `Break-even wager: ${hasSpend ? formatCurrency(breakEvenWager) : "—"}`,
      `Verdict: ${verdict}`,
    ];
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => toast.success("Summary copied to clipboard"))
      .catch(() => toast.error("Could not copy to clipboard"));
  }, [
    hasSpend,
    profitable,
    wagerN,
    capN,
    lbN,
    tipN,
    hasFrame,
    daysN,
    generatedValue,
    dealSpend,
    net,
    rateOfReturn,
    breakEvenWager,
  ]);

  return (
    <TooltipProvider delay={150}>
      <div className="space-y-4">
        <SectionHeading
          icon={Calculator}
          title="ROI Calculator"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="size-3.5" />
                Reset
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopySummary}>
                <Copy className="size-3.5" />
                Copy summary
              </Button>
            </div>
          }
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ── Inputs: the deal, entered ONCE ─────────────────────── */}
          <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <p className="mb-3 text-xs text-muted-foreground">
              Enter the deal once — spend legs, the wager you expect it to
              drive, and the frame length. Value is wager ×{" "}
              <span className="font-semibold text-foreground">
                {HOUSE_EDGE_PCT_LABEL}
              </span>
              ; weekly and daily views derive from the frame length.
            </p>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <FieldRow
                id="deal-cap"
                label="Withdraw Cap"
                help="The maximum the creator can withdraw under the deal — counted as deal spend (house cost)."
                value={cap}
                onChange={setCap}
                placeholder="e.g. 5000"
                icon={Wallet}
                iconColor="text-rose-500"
                unit="$"
              />
              <FieldRow
                id="deal-lb"
                label="LB Contribution"
                help={`Leaderboard contribution the HOUSE funds — the house pays ${LB_HOUSE_PCT_LABEL} of the prize pool (net prize × ${LB_HOUSE_PCT_LABEL}). Counted as deal spend.`}
                value={lb}
                onChange={setLb}
                placeholder="e.g. 2500"
                icon={Trophy}
                iconColor="text-rose-500"
                unit="$"
              />
              <FieldRow
                id="deal-tip"
                label="Tip / Sponsor Allowance"
                help="House-funded tip + sponsorship allowance for the deal. Included in deal spend (owner-confirmed)."
                value={tip}
                onChange={setTip}
                placeholder="e.g. 1000"
                icon={Gift}
                iconColor="text-rose-500"
                unit="$"
              />
              <FieldRow
                id="deal-wager"
                label="Expected Wager"
                help={`Total $ you expect wagered through the creator's code over the whole frame. Generated value = wager × ${HOUSE_EDGE_PCT_LABEL}.`}
                value={wager}
                onChange={setWager}
                placeholder="e.g. 200000"
                icon={TrendingUp}
                iconColor="text-emerald-500"
                unit="$"
              />
              <FieldRow
                id="deal-days"
                label="Frame Length"
                help="How many days the deal frame runs (a weekly frame = 7, bi-weekly = 14). Used to derive the daily and weekly figures."
                value={days}
                onChange={setDays}
                placeholder="e.g. 14"
                icon={CalendarDays}
                iconColor="text-blue-500"
                unit="days"
              />
            </div>
          </div>

          {/* ── Outputs ────────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* One verdict header — RoR + Net + pill, live. */}
            <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p
                    className={cn(
                      "text-3xl font-bold tracking-tight tabular-nums sm:text-4xl",
                      hasSpend
                        ? profitable
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {hasSpend ? formatRoR(rateOfReturn) : "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    rate of return (generated value ÷ deal spend)
                  </p>
                </div>
                {/* Verdict pill */}
                {hasSpend ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
                      profitable
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {profitable ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <XCircle className="size-3.5" />
                    )}
                    {profitable ? "Profitable" : "Not profitable"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
                    <Info className="size-3.5" />
                    Enter spend to evaluate
                  </span>
                )}
              </div>
              <div className="mt-3 border-t pt-2">
                <PanelRow
                  label="Net (value − spend)"
                  value={
                    hasSpend || wagerN > 0 ? formatCurrency(net) : "—"
                  }
                  valueClassName={cn(
                    hasSpend || wagerN > 0
                      ? net >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                />
                {/* Secondary weekly-basis line — only once a frame exists. */}
                {hasFrame && (hasSpend || wagerN > 0) && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    ≈ {formatCurrency(weeklyNet)} net per week over the{" "}
                    {daysN}-day frame
                  </p>
                )}
              </div>
            </div>

            {/* Generated value */}
            <StatPanel title="Generated Value" icon={TrendingUp} accent="emerald">
              <p
                className={cn(
                  "text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
                  wagerN > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                {wagerN > 0 ? formatCurrency(generatedValue) : "—"}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                wager × {HOUSE_EDGE_PCT_LABEL} house value rate
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Expected wager"
                  value={wagerN > 0 ? formatCurrency(wagerN) : "—"}
                />
                <PanelRow
                  label={`Value rate (${HOUSE_EDGE_PCT_LABEL})`}
                  value={
                    wagerN > 0 ? formatCurrency(generatedValue) : "—"
                  }
                  valueClassName={
                    wagerN > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : undefined
                  }
                />
              </div>
            </StatPanel>

            {/* Deal spend legs */}
            <StatPanel title="Deal Spend" icon={Coins} accent="rose">
              <p
                className={cn(
                  "text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
                  hasSpend
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
                )}
              >
                {hasSpend ? formatCurrency(dealSpend) : "—"}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                withdraw cap + LB contribution + tip/sponsor
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Withdraw cap"
                  value={formatCurrency(capN)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
                <PanelRow
                  label={`LB contribution (house ${LB_HOUSE_PCT_LABEL})`}
                  value={formatCurrency(lbN)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
                <PanelRow
                  label="Tip / sponsor allowance"
                  value={formatCurrency(tipN)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
              </div>
            </StatPanel>

            {/* Break-even solver */}
            <StatPanel title="Break-even Wager" icon={Crosshair} accent="amber">
              <p
                className={cn(
                  "text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
                  hasSpend ? undefined : "text-muted-foreground",
                )}
              >
                {hasSpend ? formatCurrency(breakEvenWager) : "—"}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                spend ÷ {HOUSE_EDGE_PCT_LABEL} — the same expected-wager
                formula the Profitability page uses
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Vs entered wager"
                  value={
                    hasSpend && wagerN > 0
                      ? `${wagerDelta >= 0 ? "+" : "−"}${formatCurrency(Math.abs(wagerDelta))}`
                      : "—"
                  }
                  valueClassName={cn(
                    hasSpend && wagerN > 0
                      ? wagerDelta >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                />
                {hasSpend && wagerN > 0 && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    {wagerDelta >= 0
                      ? "Entered wager clears break-even by this much."
                      : "Entered wager falls short of break-even by this much."}
                  </p>
                )}
              </div>
            </StatPanel>

            {/* Weekly / daily derived figures */}
            <StatPanel title="Run-rate" icon={CalendarDays} accent="blue">
              <p
                className={cn(
                  "text-2xl font-bold tracking-tight tabular-nums sm:text-3xl",
                  hasFrame && wagerN > 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                {hasFrame && wagerN > 0 ? formatCurrency(weeklyValue) : "—"}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                projected weekly value
                {hasFrame ? ` (derived from the ${daysN}-day frame)` : ""}
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Daily value"
                  value={
                    hasFrame && wagerN > 0 ? formatCurrency(dailyValue) : "—"
                  }
                  valueClassName={
                    hasFrame && wagerN > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : undefined
                  }
                />
                <PanelRow
                  label="Weekly value"
                  value={
                    hasFrame && wagerN > 0 ? formatCurrency(weeklyValue) : "—"
                  }
                  valueClassName={
                    hasFrame && wagerN > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : undefined
                  }
                />
                <PanelRow
                  label="Daily spend"
                  value={
                    hasFrame && hasSpend ? formatCurrency(dailySpend) : "—"
                  }
                  valueClassName={
                    hasFrame && hasSpend
                      ? "text-rose-600 dark:text-rose-400"
                      : undefined
                  }
                />
                <PanelRow
                  label="Weekly spend"
                  value={
                    hasFrame && hasSpend ? formatCurrency(weeklySpend) : "—"
                  }
                  valueClassName={
                    hasFrame && hasSpend
                      ? "text-rose-600 dark:text-rose-400"
                      : undefined
                  }
                />
              </div>
            </StatPanel>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
