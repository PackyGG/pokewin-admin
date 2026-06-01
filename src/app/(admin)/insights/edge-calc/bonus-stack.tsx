"use client";

import * as React from "react";
import {
  Coins,
  Sparkles,
  Receipt,
  TrendingUp,
  Sigma,
  Package,
  Gauge,
} from "lucide-react";

import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { PackEdgeRow } from "@/lib/queries/insights-edge-calc";
import { runBonusStack, formatPct, formatSignedUsd } from "./math";

/**
 * Bonus Stack ROI — given a pack's edge, what wager requirement keeps
 * a deposit-bonus offer house-positive in expectation?
 *
 * The break-even formula is independent of bonus size: it's purely a
 * function of the pack's house edge:
 *
 *   wagerRequirement_breakeven = bonus / (bonus × houseEdge) → bonus
 *                              cancels, leaving 1 / houseEdge.
 *
 * Numerically:
 *   • 5% edge  → 20× wager
 *   • 10% edge → 10× wager
 *   • 25% edge → 4× wager
 *
 * The form lets the admin try arbitrary wager-X / bonus / deposit
 * combos and shows whether each pencils out. A small table walks
 * through the realistic 0%-50% edge ladder so the breakeven cliff is
 * visible at a glance.
 */

type PackOption = Pick<
  PackEdgeRow,
  "id" | "name" | "priceUsd" | "theoreticalRtp"
>;

const EDGE_LADDER = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5] as const;

export function BonusStackTab({ packs }: { packs: PackOption[] }) {
  const defaultPack = React.useMemo(() => {
    return packs.find((p) => p.theoreticalRtp !== null) ?? packs[0] ?? null;
  }, [packs]);

  const [packId, setPackId] = React.useState<string>(defaultPack?.id ?? "");
  const [deposit, setDeposit] = React.useState<number>(100);
  const [bonusPct, setBonusPct] = React.useState<number>(100);
  const [wagerX, setWagerX] = React.useState<number>(5);

  const pack = React.useMemo(
    () => packs.find((p) => p.id === packId) ?? defaultPack,
    [packs, packId, defaultPack],
  );

  const result = React.useMemo(() => {
    if (pack === null || pack.theoreticalRtp === null) return null;
    return runBonusStack({
      deposit,
      bonusPct,
      wagerRequirementX: wagerX,
      packRtp: pack.theoreticalRtp,
    });
  }, [pack, deposit, bonusPct, wagerX]);

  if (pack === null) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
        Add a pack with a configured pool to run bonus-stack math.
      </div>
    );
  }

  // Empty/no-pool guard — without a pack RTP we can't compute edge.
  if (result === null || pack.theoreticalRtp === null) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">
        {pack.name} has no pool configured — pick a different pack to compute
        bonus break-even.
      </div>
    );
  }

  const packEdge = 1 - pack.theoreticalRtp;
  const housePnlAccent = result.netHousePnl >= 0 ? "emerald" : "rose";

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        {/* ── Inputs ──────────────────────────────────────────────── */}
        <FadeIn>
          <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-amber-500/[0.08] blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />
            <div className="relative space-y-5 p-5">
              <SectionHeading icon={Coins} title="Inputs" />
              <div className="space-y-4">
                {/* Pack picker */}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bonus-pack"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <Package className="size-3.5" />
                    Pack (edge source)
                  </Label>
                  <select
                    id="bonus-pack"
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
                          ? ` — edge ${((1 - p.theoreticalRtp) * 100).toFixed(1)}%`
                          : " — no pool"}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    Pack edge:{" "}
                    <span className="font-medium text-foreground">
                      {formatPct(packEdge)}
                    </span>{" "}
                    — break-even wager{" "}
                    <span className="font-medium text-foreground">
                      {result.breakEvenWagerX !== null
                        ? `${result.breakEvenWagerX.toFixed(1)}×`
                        : "n/a"}
                    </span>
                  </p>
                </div>

                {/* Deposit */}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bonus-deposit"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <Receipt className="size-3.5" />
                    Deposit (USD)
                  </Label>
                  <Input
                    id="bonus-deposit"
                    type="number"
                    min={0}
                    step={10}
                    value={deposit}
                    onChange={(e) =>
                      setDeposit(Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                </div>

                {/* Bonus % */}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bonus-pct"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <Sparkles className="size-3.5" />
                    Bonus %
                  </Label>
                  <Input
                    id="bonus-pct"
                    type="number"
                    min={0}
                    max={500}
                    step={10}
                    value={bonusPct}
                    onChange={(e) =>
                      setBonusPct(Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    e.g. 100% = double-deposit bonus
                  </p>
                </div>

                {/* Wager requirement */}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bonus-wager"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <Sigma className="size-3.5" />
                    Wager Requirement (× bonus)
                  </Label>
                  <Input
                    id="bonus-wager"
                    type="number"
                    min={0}
                    step={0.5}
                    value={wagerX}
                    onChange={(e) =>
                      setWagerX(Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Total wager required before withdraw = X × bonus
                  </p>
                </div>
              </div>
            </div>
          </div>
        </FadeIn>

        {/* ── Results ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Bonus Given"
              value={formatCurrency(result.bonusGiven)}
              sub={`${bonusPct}% on ${formatCurrency(deposit)}`}
              icon={Sparkles}
              accent="rose"
            />
            <KpiTile
              label="Wager Required"
              value={formatCurrency(result.wagerRequired)}
              sub={`${wagerX}× bonus`}
              icon={Sigma}
              accent="blue"
            />
            <KpiTile
              label="Expected GGR"
              value={formatCurrency(result.expectedHouseGgr)}
              sub={`wager × ${formatPct(packEdge)} edge`}
              icon={Gauge}
              accent="emerald"
            />
            <KpiTile
              label="House Net"
              value={formatSignedUsd(result.netHousePnl)}
              sub={result.houseBreakEven ? "break-even ✓" : "underwater"}
              icon={TrendingUp}
              accent={housePnlAccent}
            />
          </div>

          <StatPanel
            title="Verdict"
            icon={result.houseBreakEven ? Sparkles : Gauge}
            accent={housePnlAccent}
          >
            <p
              className={cn(
                "text-2xl font-bold tabular-nums",
                result.netHousePnl >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
              {formatSignedUsd(result.netHousePnl)}
            </p>
            <p className="text-xs text-muted-foreground">
              expected net house P&L over the full wager requirement
            </p>
            <div className="mt-3 space-y-1">
              <PanelRow
                label="Bonus given (house cost)"
                value={formatCurrency(result.bonusGiven)}
                valueClassName="text-rose-600 dark:text-rose-400"
              />
              <PanelRow
                label="Expected GGR (house revenue)"
                value={formatCurrency(result.expectedHouseGgr)}
                valueClassName="text-emerald-600 dark:text-emerald-400"
              />
              <PanelRow
                label="Min wager × to break even"
                value={
                  result.breakEvenWagerX !== null
                    ? `${result.breakEvenWagerX.toFixed(2)}× bonus`
                    : "impossible at 0% edge"
                }
              />
              <PanelRow
                label="Current wager × vs. break-even"
                value={
                  result.breakEvenWagerX !== null
                    ? `${(wagerX / result.breakEvenWagerX).toFixed(2)}×`
                    : "—"
                }
                valueClassName={
                  result.breakEvenWagerX !== null &&
                  wagerX >= result.breakEvenWagerX
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              />
            </div>
          </StatPanel>

          {/* Edge ladder reference table */}
          <SectionHeading
            icon={Sigma}
            title="Break-Even Wager Requirement by Edge"
          />
          <FadeIn>
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">
                        Pack Edge
                      </th>
                      <th className="px-4 py-3 text-right font-semibold">
                        Break-Even Wager ×
                      </th>
                      <th className="px-4 py-3 text-right font-semibold">
                        Current Setup
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {EDGE_LADDER.map((edge) => {
                      const breakEvenX = edge > 0 ? 1 / edge : null;
                      const isCurrent =
                        Math.abs(edge - packEdge) <
                        // 1% bucket tolerance
                        0.01;
                      const meetsBE =
                        breakEvenX !== null && wagerX >= breakEvenX;
                      return (
                        <tr
                          key={edge}
                          className={cn(
                            "hover:bg-muted/30",
                            isCurrent && "bg-primary/[0.04]",
                          )}
                        >
                          <td className="px-4 py-3 font-medium tabular-nums">
                            {formatPct(edge, 0)}
                            {isCurrent && (
                              <span className="ml-2 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                Current
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {breakEvenX !== null
                              ? `${breakEvenX.toFixed(2)}×`
                              : "n/a"}
                          </td>
                          <td
                            className={cn(
                              "px-4 py-3 text-right tabular-nums font-medium",
                              meetsBE
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-600 dark:text-rose-400",
                            )}
                          >
                            {meetsBE ? "covers" : "underwater"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </FadeIn>

          {/* Method note */}
          <FadeIn>
            <div className="rounded-xl border border-dashed bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
              <p className="mb-2 font-semibold text-foreground">
                Math walkthrough
              </p>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  Bonus = {formatCurrency(deposit)} × {bonusPct}% ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.bonusGiven)}
                  </span>
                </li>
                <li>
                  Required wager = {wagerX}× bonus ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.wagerRequired)}
                  </span>
                </li>
                <li>
                  Expected GGR = wager × edge ={" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(result.expectedHouseGgr)}
                  </span>
                </li>
                <li>
                  Net = GGR − bonus ={" "}
                  <span
                    className={cn(
                      "font-medium",
                      result.netHousePnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {formatSignedUsd(result.netHousePnl)}
                  </span>
                </li>
                <li>
                  Break-even wager × = 1 / edge ={" "}
                  <span className="font-medium text-foreground">
                    {result.breakEvenWagerX !== null
                      ? `${result.breakEvenWagerX.toFixed(2)}×`
                      : "n/a"}
                  </span>{" "}
                  — independent of bonus size.
                </li>
              </ol>
            </div>
          </FadeIn>
        </div>
      </div>
    </div>
  );
}
