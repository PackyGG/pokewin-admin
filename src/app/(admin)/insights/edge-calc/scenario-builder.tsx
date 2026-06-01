"use client";

import * as React from "react";
import {
  Wand2,
  Package,
  Gauge,
  Coins,
  Sigma,
  Repeat,
  Receipt,
  Sparkles,
} from "lucide-react";

import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { PackEdgeRow } from "@/lib/queries/insights-edge-calc";
import { runScenario, formatPct, formatSignedUsd } from "./math";

/**
 * Scenario Builder — interactive form that lets the admin layer:
 *   • a pack pick (sources priceUsd + theoretical RTP)
 *   • repetitions, borrow %, deposit bonus %, rakeback %, deposit size
 *
 * Reactively recomputes the projected user / house P&L. The math runs
 * in-process via the shared `runScenario` helper — same numbers the
 * server uses for the static panels, so the client and server view
 * never disagree on what a given input set produces.
 *
 * Why a client component:
 *   The form is live-updating; round-tripping to the server on every
 *   keystroke would feel laggy and burn render quota for nothing. The
 *   pack catalog comes in as a serialized prop (already on the server
 *   for the Packs tab) so this component is dep-free relative to data
 *   layer.
 */

type PackOption = Pick<
  PackEdgeRow,
  | "id"
  | "name"
  | "slug"
  | "priceUsd"
  | "cardsPerOpen"
  | "theoreticalRtp"
  | "expectedCardValue"
  | "expectedPayoutPerOpen"
>;

const REP_PRESETS = [1, 10, 100, 1000] as const;

export function ScenarioBuilder({ packs }: { packs: PackOption[] }) {
  // Default to the first pack with a populated pool so the math has
  // something meaningful to show. Falls back to the first overall when
  // every pack is empty (fresh install).
  const defaultPack = React.useMemo(() => {
    return packs.find((p) => p.theoreticalRtp !== null) ?? packs[0] ?? null;
  }, [packs]);

  const [packId, setPackId] = React.useState<string>(defaultPack?.id ?? "");
  const [repetitions, setRepetitions] = React.useState<number>(100);
  const [borrowPct, setBorrowPct] = React.useState<number>(0);
  const [depositBonusPct, setDepositBonusPct] = React.useState<number>(0);
  const [rakebackPct, setRakebackPct] = React.useState<number>(0);
  const [deposit, setDeposit] = React.useState<number>(100);

  const pack = React.useMemo(
    () => packs.find((p) => p.id === packId) ?? defaultPack,
    [packs, packId, defaultPack],
  );

  const result = React.useMemo(() => {
    if (pack == null) return null;
    return runScenario({
      packPrice: pack.priceUsd,
      packRtp: pack.theoreticalRtp ?? 0,
      repetitions,
      borrowPct,
      depositBonusPct,
      rakebackPct,
      deposit,
    });
  }, [pack, repetitions, borrowPct, depositBonusPct, rakebackPct, deposit]);

  if (!pack || !result) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
        Add a pack to the catalog first — the scenario builder needs at
        least one pack with a configured pool.
      </div>
    );
  }

  // House-POV accents for the result panels. userPnl > 0 = user wins =
  // 🔴 rose (we lose); userPnl < 0 = user loses = 🟢 emerald.
  const userPnlAccent: "rose" | "emerald" =
    result.userPnl > 0 ? "rose" : "emerald";
  const housePnlAccent: "emerald" | "rose" =
    result.housePnl >= 0 ? "emerald" : "rose";

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        {/* ── Inputs ──────────────────────────────────────────────── */}
        <FadeIn>
          <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-purple-500/[0.08] blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />
            <div className="relative space-y-5 p-5">
              <SectionHeading icon={Wand2} title="Inputs" />
              <div className="space-y-4">
                {/* Pack picker — native <select> wrapper for keyboard /
                    full-page rendering. No Combobox needed; the catalog
                    is small enough. */}
                <div className="space-y-1.5">
                  <Label htmlFor="scenario-pack" className="flex items-center gap-1.5 text-xs">
                    <Package className="size-3.5" />
                    Pack
                  </Label>
                  <select
                    id="scenario-pack"
                    value={packId}
                    onChange={(e) => setPackId(e.target.value)}
                    className={cn(
                      "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm",
                      "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "dark:bg-input/30 dark:hover:bg-input/50",
                    )}
                  >
                    {packs.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.theoreticalRtp !== null
                          ? ` — RTP ${(p.theoreticalRtp * 100).toFixed(1)}%`
                          : " — no pool"}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    {formatCurrency(pack.priceUsd)} · {pack.cardsPerOpen}{" "}
                    cards/open · RTP{" "}
                    {pack.theoreticalRtp !== null
                      ? `${(pack.theoreticalRtp * 100).toFixed(2)}%`
                      : "—"}
                  </p>
                </div>

                {/* Repetitions — input + preset chips */}
                <div className="space-y-1.5">
                  <Label htmlFor="scenario-reps" className="flex items-center gap-1.5 text-xs">
                    <Repeat className="size-3.5" />
                    Repetitions
                  </Label>
                  <Input
                    id="scenario-reps"
                    type="number"
                    min={1}
                    step={1}
                    value={repetitions}
                    onChange={(e) =>
                      setRepetitions(Math.max(1, Number(e.target.value) || 1))
                    }
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {REP_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setRepetitions(preset)}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
                          repetitions === preset
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border/60 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {formatNumber(preset)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Borrow */}
                <NumberRow
                  id="scenario-borrow"
                  label="Borrow %"
                  hint="House lends this share of the wager."
                  value={borrowPct}
                  setValue={setBorrowPct}
                  min={0}
                  max={100}
                  step={5}
                  icon={Coins}
                />

                {/* Deposit + bonus */}
                <NumberRow
                  id="scenario-deposit"
                  label="Initial Deposit (USD)"
                  hint="Drives the deposit-bonus dollar amount."
                  value={deposit}
                  setValue={setDeposit}
                  min={0}
                  step={10}
                  icon={Receipt}
                />
                <NumberRow
                  id="scenario-bonus"
                  label="Deposit Bonus %"
                  hint="Free bonus credit added to the bankroll. House cost."
                  value={depositBonusPct}
                  setValue={setDepositBonusPct}
                  min={0}
                  max={500}
                  step={10}
                  icon={Sparkles}
                />

                {/* Rakeback */}
                <NumberRow
                  id="scenario-rake"
                  label="Rakeback %"
                  hint="Flat % of wager refunded to the user."
                  value={rakebackPct}
                  setValue={setRakebackPct}
                  min={0}
                  max={50}
                  step={1}
                  icon={Sigma}
                />
              </div>
            </div>
          </div>
        </FadeIn>

        {/* ── Results ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Gross Wager"
              value={formatCurrency(result.grossCost)}
              sub={`${formatNumber(repetitions)} opens`}
              icon={Receipt}
              accent="blue"
            />
            <KpiTile
              label="User Out-of-Pocket"
              value={formatCurrency(result.userOutOfPocket)}
              sub={borrowPct > 0 ? `${borrowPct}% borrowed` : "no borrow"}
              icon={Coins}
              accent="emerald"
            />
            <KpiTile
              label="User Net P&L"
              value={formatSignedUsd(result.userPnl)}
              sub={result.userPnl > 0 ? "user wins (E[V])" : "user loses (E[V])"}
              icon={Sparkles}
              accent={userPnlAccent}
            />
            <KpiTile
              label="House Net P&L"
              value={formatSignedUsd(result.housePnl)}
              sub={result.housePnl >= 0 ? "house wins" : "house loses"}
              icon={Gauge}
              accent={housePnlAccent}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <StatPanel title="User Side" icon={Receipt} accent="blue">
              <p className="text-2xl font-bold tabular-nums">
                {formatCurrency(result.expectedUserPayout)}
              </p>
              <p className="text-xs text-muted-foreground">
                expected payout to user
              </p>
              <div className="mt-3 space-y-1">
                <PanelRow
                  label="Gross wager"
                  value={formatCurrency(result.grossCost)}
                />
                <PanelRow
                  label="Out-of-pocket"
                  value={formatCurrency(result.userOutOfPocket)}
                />
                <PanelRow
                  label="Bonus credit"
                  value={formatCurrency(result.depositBonusGiven)}
                />
                <PanelRow
                  label="Rakeback claimed"
                  value={formatCurrency(result.rakebackClaimed)}
                />
                <PanelRow
                  label="Net P&L"
                  value={formatSignedUsd(result.userPnl)}
                  // User P&L positive = user winning = 🔴 rose
                  // (we owe). Negative = user losing = 🟢 emerald
                  // (we gain). Strict House-POV per CLAUDE.md.
                  valueClassName={
                    result.userPnl > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                />
              </div>
            </StatPanel>
            <StatPanel title="House Side" icon={Gauge} accent={housePnlAccent}>
              <p
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  result.housePnl >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {formatSignedUsd(result.housePnl)}
              </p>
              <p className="text-xs text-muted-foreground">
                expected house P&L
              </p>
              <div className="mt-3 space-y-1">
                <PanelRow
                  label="Pack RTP used"
                  value={
                    pack.theoreticalRtp !== null
                      ? formatPct(pack.theoreticalRtp)
                      : "—"
                  }
                />
                <PanelRow
                  label="Bonus cost"
                  value={formatCurrency(result.depositBonusGiven)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
                <PanelRow
                  label="Rakeback cost"
                  value={formatCurrency(result.rakebackClaimed)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
                <PanelRow
                  label="Edge per open"
                  value={
                    pack.theoreticalRtp !== null
                      ? formatCurrency(
                          pack.priceUsd * (1 - pack.theoreticalRtp),
                        )
                      : "—"
                  }
                />
                <PanelRow
                  label="Break-even opens"
                  value={
                    result.breakEvenOpens === null
                      ? "n/a"
                      : result.breakEvenOpens === 0
                        ? "instant"
                        : formatNumber(Math.ceil(result.breakEvenOpens))
                  }
                />
              </div>
            </StatPanel>
          </div>

          {/* ── Math walkthrough (auditable) ─────────────────────── */}
          <FadeIn>
            <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-2 font-semibold text-foreground">
                Math walkthrough
              </p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  Wager = {formatNumber(repetitions)} ×{" "}
                  {formatCurrency(pack.priceUsd)} ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.grossCost)}
                  </span>
                </li>
                <li>
                  Out-of-pocket = wager × (1 − borrow) ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.userOutOfPocket)}
                  </span>
                </li>
                <li>
                  E[Payout] = wager × RTP ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.expectedPayout)}
                  </span>{" "}
                  · user share ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.expectedUserPayout)}
                  </span>
                </li>
                <li>
                  Bonus = {formatCurrency(deposit)} × {depositBonusPct}% ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.depositBonusGiven)}
                  </span>
                </li>
                <li>
                  Rakeback = wager × {rakebackPct}% ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.rakebackClaimed)}
                  </span>
                </li>
                <li>
                  User P&L = user payout − out-of-pocket + rakeback + bonus ={" "}
                  <span
                    className={cn(
                      "font-medium",
                      result.userPnl > 0
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {formatSignedUsd(result.userPnl)}
                  </span>
                </li>
                <li>
                  House P&L = −user P&L ={" "}
                  <span
                    className={cn(
                      "font-medium",
                      result.housePnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {formatSignedUsd(result.housePnl)}
                  </span>
                </li>
              </ol>
            </div>
          </FadeIn>
        </div>
      </div>
    </div>
  );
}

// ─── Inline helper — labeled numeric input with hint + icon ──────────

function NumberRow({
  id,
  label,
  hint,
  value,
  setValue,
  min,
  max,
  step,
  icon: Icon,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  setValue: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  icon: React.ElementType;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5" />
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          const clampedHigh = max != null ? Math.min(max, next) : next;
          const clampedLow = min != null ? Math.max(min, clampedHigh) : clampedHigh;
          setValue(clampedLow);
        }}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
