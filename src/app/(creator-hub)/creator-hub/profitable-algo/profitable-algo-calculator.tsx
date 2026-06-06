"use client";

import * as React from "react";
import {
  Calculator,
  TrendingUp,
  Coins,
  CalendarDays,
  Info,
  CheckCircle2,
  XCircle,
  Gauge,
  Wallet,
  Trophy,
  Gift,
  Sparkles,
} from "lucide-react";

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
  type AccentColor,
} from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Profitable Algo — Deal Profitability calculator (Creator Hub).
 *
 * A PURE calculator: no DB, no server data, no API. The manager types deal
 * parameters and the tool evaluates whether the deal is profitable using the
 * owner's exact math (plan: iridescent-mixing-lecun.md).
 *
 *   DEAL_VALUE_RATE = 0.075  ("value generated per $ wagered" for deal
 *   economics — DISTINCT from the 10.8% / 10% gross edge in the Risk tool).
 *
 * Deal Profitability
 *   Generated Value = WAGER × 0.075
 *   Deal Spend      = MAX WITHDRAW CAP + LB CONTRIBUTION + TIP/SPONSOR ALLOWANCE
 *   Rate of Return  = Generated Value / Deal Spend     → profitable when > 1
 *
 * Performance Forecast (over x days)
 *   Generated Value = (WAGER over x days) × 0.075
 *   Daily Value     = Generated Value / x days
 *   Weekly Value    = Daily Value × 7
 *
 * Daily Spend
 *   Max Weekly Spend = WEEKLY CAP + WEEKLY LB FUNDING + WEEKLY TIP/SPONSOR ALLOWANCE
 *   Daily Spend      = Max Weekly Spend / 7
 *
 * House-POV colors:
 *   • Generated Value (the value the deal generates for the HOUSE) → emerald.
 *   • Spend (what the deal COSTS the house) → rose.
 *   • Rate of Return ≥ 1 → emerald (profitable), < 1 → rose (loss-making).
 *
 * Client-only: all state + math live here; the page is a thin server shell.
 */

/** Value generated per $ wagered for deal economics (owner-chosen, 7.5%). */
const DEAL_VALUE_RATE = 0.075;

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

// ─── labelled input with hover help ────────────────────────────────

function FieldRow({
  id,
  label,
  help,
  value,
  onChange,
  placeholder,
  icon: Icon,
  iconColor,
}: {
  id: string;
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  icon: React.ElementType;
  iconColor: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", iconColor)} />
        <span className="min-w-0 truncate">{label}</span>
        {/* Hover help — mirrors the dashboard's (i) info affordance. */}
        <Tooltip>
          <TooltipTrigger
            type="button"
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
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono"
      />
    </div>
  );
}

// ─── verdict banner ────────────────────────────────────────────────

function VerdictBanner({
  profitable,
  hasSpend,
  ror,
  label,
}: {
  profitable: boolean;
  hasSpend: boolean;
  ror: number;
  label: string;
}) {
  // No spend entered yet → neutral prompt (don't claim "infinitely
  // profitable" when the denominator is 0).
  if (!hasSpend) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3.5 py-2.5 text-sm text-blue-600 dark:text-blue-400">
        <Info className="size-4 shrink-0" />
        <span>Enter a spend value to evaluate {label}.</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-semibold",
        profitable
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      )}
    >
      {profitable ? (
        <CheckCircle2 className="size-4 shrink-0" />
      ) : (
        <XCircle className="size-4 shrink-0" />
      )}
      <span>
        {profitable ? "Profitable" : "Not profitable"} — {label} returns{" "}
        {formatRoR(ror)}{" "}
        <span className="font-normal opacity-80">
          ({profitable ? "above" : "below"} 1.00× break-even)
        </span>
      </span>
    </div>
  );
}

// ─── main calculator ───────────────────────────────────────────────

export function ProfitableAlgoCalculator() {
  // Deal Profitability inputs (one-off deal evaluation).
  const [wager, setWager] = React.useState("");
  const [maxWithdrawCap, setMaxWithdrawCap] = React.useState("");
  const [lbContribution, setLbContribution] = React.useState("");
  const [tipSponsorAllowance, setTipSponsorAllowance] = React.useState("");

  // Performance Forecast inputs (wager-over-x-days run-rate).
  const [wagerOverDays, setWagerOverDays] = React.useState("");
  const [days, setDays] = React.useState("");

  // Daily Spend inputs (weekly spend budget → per day).
  const [weeklyCap, setWeeklyCap] = React.useState("");
  const [weeklyLbFunding, setWeeklyLbFunding] = React.useState("");
  const [weeklyTipSponsor, setWeeklyTipSponsor] = React.useState("");

  // ── Deal Profitability math ──
  const wagerN = num(wager);
  const generatedValue = wagerN * DEAL_VALUE_RATE;
  const dealSpend =
    num(maxWithdrawCap) + num(lbContribution) + num(tipSponsorAllowance);
  const rateOfReturn = dealSpend > 0 ? generatedValue / dealSpend : Infinity;
  const dealProfitable = dealSpend > 0 && rateOfReturn > 1;

  // ── Performance Forecast math ──
  const daysN = num(days);
  const forecastWagerN = num(wagerOverDays);
  const forecastGeneratedValue = forecastWagerN * DEAL_VALUE_RATE;
  const dailyValue = daysN > 0 ? forecastGeneratedValue / daysN : 0;
  const weeklyValue = dailyValue * 7;

  // ── Daily Spend math ──
  const maxWeeklySpend =
    num(weeklyCap) + num(weeklyLbFunding) + num(weeklyTipSponsor);
  const dailySpend = maxWeeklySpend / 7;

  // ── Forecast vs spend verdict (weekly value vs max weekly spend) ──
  const weeklyRoR =
    maxWeeklySpend > 0 ? weeklyValue / maxWeeklySpend : Infinity;
  const weeklyProfitable = maxWeeklySpend > 0 && weeklyRoR > 1;

  return (
    <TooltipProvider delay={150}>
      <div className="space-y-6">
        {/* ── 1. Deal Profitability ────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeading icon={Calculator} title="Deal Profitability" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Inputs */}
            <div className="surface-sheen rounded-2xl border bg-card p-4 sm:p-5">
              <p className="mb-3 text-xs text-muted-foreground">
                One-off check: does a deal&apos;s generated value beat its total
                spend? Value is wager ×{" "}
                <span className="font-semibold text-foreground">7.5%</span>.
              </p>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldRow
                  id="dp-wager"
                  label="Wager"
                  help="Total $ wagered through the creator's code under this deal. Generated value = wager × 7.5%."
                  value={wager}
                  onChange={setWager}
                  placeholder="e.g. 200000"
                  icon={TrendingUp}
                  iconColor="text-emerald-500"
                />
                <FieldRow
                  id="dp-cap"
                  label="Max Withdraw Cap"
                  help="The maximum the creator can withdraw under the deal — counted as deal spend (house cost)."
                  value={maxWithdrawCap}
                  onChange={setMaxWithdrawCap}
                  placeholder="e.g. 5000"
                  icon={Wallet}
                  iconColor="text-rose-500"
                />
                <FieldRow
                  id="dp-lb"
                  label="LB Contribution"
                  help="Leaderboard contribution the HOUSE funds = prize pool × house share %. Counted as deal spend."
                  value={lbContribution}
                  onChange={setLbContribution}
                  placeholder="e.g. 2500"
                  icon={Trophy}
                  iconColor="text-rose-500"
                />
                <FieldRow
                  id="dp-tip"
                  label="Tip / Sponsor Allowance"
                  help="House-funded tip + sponsorship allowance for the deal. Included in deal spend (owner-confirmed)."
                  value={tipSponsorAllowance}
                  onChange={setTipSponsorAllowance}
                  placeholder="e.g. 1000"
                  icon={Gift}
                  iconColor="text-rose-500"
                />
              </div>
            </div>

            {/* Output */}
            <div className="space-y-3">
              <StatPanel
                title="Result"
                icon={Gauge}
                accent={
                  (dealSpend > 0
                    ? dealProfitable
                      ? "emerald"
                      : "rose"
                    : "blue") as AccentColor
                }
              >
                <p
                  className={cn(
                    "text-3xl font-bold tracking-tight tabular-nums sm:text-4xl",
                    dealSpend > 0
                      ? dealProfitable
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground",
                  )}
                >
                  {formatRoR(rateOfReturn)}
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  rate of return (generated value ÷ deal spend)
                </p>
                <div className="border-t pt-2">
                  <PanelRow
                    label="Generated Value (wager × 7.5%)"
                    value={formatCurrency(generatedValue)}
                    valueClassName="text-emerald-600 dark:text-emerald-400"
                  />
                  <PanelRow
                    label="Deal Spend (total cost)"
                    value={formatCurrency(dealSpend)}
                    valueClassName="text-rose-600 dark:text-rose-400"
                  />
                  <PanelRow
                    label="Net (value − spend)"
                    value={formatCurrency(generatedValue - dealSpend)}
                    valueClassName={cn(
                      dealSpend > 0
                        ? generatedValue - dealSpend >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground",
                    )}
                  />
                </div>
              </StatPanel>
              <VerdictBanner
                profitable={dealProfitable}
                hasSpend={dealSpend > 0}
                ror={rateOfReturn}
                label="this deal"
              />
            </div>
          </div>
        </section>

        {/* ── 2. Performance Forecast ──────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeading icon={CalendarDays} title="Performance Forecast" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="surface-sheen rounded-2xl border bg-card p-4 sm:p-5">
              <p className="mb-3 text-xs text-muted-foreground">
                Project run-rate value from wager over a number of days, then
                annualize to a daily + weekly figure.
              </p>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <FieldRow
                  id="pf-wager"
                  label="Wager over X days"
                  help="Total $ wagered across the period you're forecasting. Generated value = this × 7.5%."
                  value={wagerOverDays}
                  onChange={setWagerOverDays}
                  placeholder="e.g. 600000"
                  icon={TrendingUp}
                  iconColor="text-emerald-500"
                />
                <FieldRow
                  id="pf-days"
                  label="X days"
                  help="Number of days the wager above was generated over — used to derive the daily run-rate."
                  value={days}
                  onChange={setDays}
                  placeholder="e.g. 30"
                  icon={CalendarDays}
                  iconColor="text-blue-500"
                />
              </div>
            </div>

            <StatPanel title="Projected Value" icon={Sparkles} accent="emerald">
              <p className="text-3xl font-bold tracking-tight tabular-nums text-emerald-600 dark:text-emerald-400 sm:text-4xl">
                {formatCurrency(weeklyValue)}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                projected weekly value
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Generated Value (wager × 7.5%)"
                  value={formatCurrency(forecastGeneratedValue)}
                  valueClassName="text-emerald-600 dark:text-emerald-400"
                />
                <PanelRow
                  label={`Daily Value (÷ ${daysN > 0 ? daysN : "x"} days)`}
                  value={daysN > 0 ? formatCurrency(dailyValue) : "—"}
                  valueClassName="text-emerald-600 dark:text-emerald-400"
                />
                <PanelRow
                  label="Weekly Value (daily × 7)"
                  value={daysN > 0 ? formatCurrency(weeklyValue) : "—"}
                  valueClassName="text-emerald-600 dark:text-emerald-400"
                />
              </div>
            </StatPanel>
          </div>
        </section>

        {/* ── 3. Daily Spend ───────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeading icon={Coins} title="Daily Spend" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="surface-sheen rounded-2xl border bg-card p-4 sm:p-5">
              <p className="mb-3 text-xs text-muted-foreground">
                Turn a weekly spend budget into a per-day allowance. Max weekly
                spend = weekly cap + weekly LB funding + weekly tip/sponsor.
              </p>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
                <FieldRow
                  id="ds-cap"
                  label="Weekly Cap"
                  help="Weekly withdrawal cap the house funds for the creator."
                  value={weeklyCap}
                  onChange={setWeeklyCap}
                  placeholder="e.g. 5000"
                  icon={Wallet}
                  iconColor="text-rose-500"
                />
                <FieldRow
                  id="ds-lb"
                  label="Weekly LB Funding"
                  help="Weekly leaderboard funding the house contributes = weekly prize pool × house share %."
                  value={weeklyLbFunding}
                  onChange={setWeeklyLbFunding}
                  placeholder="e.g. 2000"
                  icon={Trophy}
                  iconColor="text-rose-500"
                />
                <FieldRow
                  id="ds-tip"
                  label="Weekly Tip / Sponsor"
                  help="Weekly house-funded tip + sponsorship allowance."
                  value={weeklyTipSponsor}
                  onChange={setWeeklyTipSponsor}
                  placeholder="e.g. 700"
                  icon={Gift}
                  iconColor="text-rose-500"
                />
              </div>
            </div>

            <StatPanel title="Spend Budget" icon={Coins} accent="rose">
              <p className="text-3xl font-bold tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-4xl">
                {formatCurrency(dailySpend)}
              </p>
              <p className="mb-2 text-xs text-muted-foreground">
                daily spend (max weekly spend ÷ 7)
              </p>
              <div className="border-t pt-2">
                <PanelRow
                  label="Max Weekly Spend"
                  value={formatCurrency(maxWeeklySpend)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
                <PanelRow
                  label="Daily Spend (÷ 7)"
                  value={formatCurrency(dailySpend)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
              </div>
            </StatPanel>
          </div>

          {/* Forecast-vs-spend verdict: does the projected weekly value beat
              the max weekly spend? Only meaningful once both a forecast and a
              weekly spend are entered. */}
          {(weeklyValue > 0 || maxWeeklySpend > 0) && (
            <VerdictBanner
              profitable={weeklyProfitable}
              hasSpend={maxWeeklySpend > 0}
              ror={weeklyRoR}
              label="the weekly run-rate vs spend"
            />
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}
