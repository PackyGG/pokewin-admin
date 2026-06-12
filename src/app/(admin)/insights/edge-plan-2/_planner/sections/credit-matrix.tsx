"use client";

import * as React from "react";
import { Grid3x3, PiggyBank } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  CREDIT_MATRIX_PROGRAM_IDS,
  CREDIT_MATRIX_PROGRAM_LABELS,
  clamp,
  getMatrixCell,
  matrixCellKey,
  matrixProgramRatesV2,
  matrixSavingsWindowUsd,
  programSavingsUsd,
  type CreditMatrixProgramId,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { EmptyLever } from "../components/empty-lever";
import { LeverHint } from "../components/lever-hint";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";

/**
 * CreditMatrixSection — the reward-source crediting matrix (owner spec #15,
 * planner-only — nothing here exists in the backend).
 *
 * Rows = the measured 30d $ paid through each reward source (assembled from
 * legs already on the baseline — zero new scans). Columns = the loyalty
 * programs with their cost-rate per $1 of wager derived from the real legs
 * (shards from the planned shard config). Each cell = the CREDIT % that
 * reward-funded wager keeps earning in that program (100% = today).
 *
 *   savings(program) = rate × reWagerRate × Σ_source volume × (1 − cell)
 *
 * Savings are a cost REDUCTION → the lever row and readouts are EMERALD
 * (house keeps the money). HONEST copy: the funding source of any single
 * bet is untraceable in the ledger, so `matrixReWagerRate` is the clearly
 * labeled assumption knob.
 */
export function CreditMatrixSection({
  baseline,
  levers,
  projection,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  projection: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const rates = React.useMemo(
    () => matrixProgramRatesV2(baseline, levers),
    [baseline, levers],
  );
  const sources = baseline.rewardSourceVolumes;
  const totalSavings = matrixSavingsWindowUsd(baseline, levers);
  const days = Math.max(1, baseline.periodDays);
  const monthlySavings = (totalSavings / days) * 30;
  const reWagerRate = clamp(levers.matrixReWagerRate, 0, 1);

  const setCell = React.useCallback(
    (sourceId: string, programId: CreditMatrixProgramId, pct: number) => {
      setLevers((s) => {
        const key = matrixCellKey(sourceId, programId);
        const frac = clamp(pct / 100, 0, 1);
        const next = { ...s.matrixCells };
        // Sparse store: 100% credit = the default = no key.
        if (frac >= 1) delete next[key];
        else next[key] = frac;
        return { ...s, matrixCells: next };
      });
    },
    [setLevers],
  );

  return (
    <div className="space-y-4">
      <StatPanel
        title={
          <RewardPanelTitle
            label="Crediting matrix"
            dragPct={leverEdgeDragPct(projection, "credit-matrix")}
          />
        }
        icon={Grid3x3}
        accent="emerald"
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: should bonus money earn loyalty rewards again?
          100% = it does (today); dial a cell down to stop the double-dip.
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Today every re-wagered reward dollar earns the full loyalty stack
          again (shards, XP, rakeback, race points, leaderboard volume) like a
          fresh deposit dollar. Set the credit % per reward source × program:
          100% = current behavior, 0% = reward-funded wager earns nothing
          there. Savings reduce reward cost → emerald.
        </p>

        {sources.length === 0 ? (
          <EmptyLever note="No measured reward-source volumes on the baseline — the matrix has no rows to credit." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">Reward source</TableHead>
                  <TableHead className="text-right">30d paid</TableHead>
                  {CREDIT_MATRIX_PROGRAM_IDS.map((p) => {
                    const rate = rates.find((r) => r.programId === p);
                    return (
                      <TableHead key={p} className="text-right">
                        <span className="block">
                          {CREDIT_MATRIX_PROGRAM_LABELS[p]}
                        </span>
                        <span className="block text-[10px] font-normal normal-case tabular-nums text-muted-foreground">
                          {formatPct(rate?.ratePerWagerDollar ?? 0, 3)} / $
                          wager
                        </span>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => (
                  <TableRow key={s.sourceId}>
                    <TableCell className="font-medium">{s.label}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${TEXT_TONE.rose}`}
                    >
                      {formatCurrency(s.amountUsd)}
                    </TableCell>
                    {CREDIT_MATRIX_PROGRAM_IDS.map((p) => (
                      <TableCell key={p} className="text-right">
                        <MatrixCellInput
                          sourceId={s.sourceId}
                          sourceLabel={s.label}
                          programId={p}
                          valuePct={
                            getMatrixCell(levers.matrixCells, s.sourceId, p) *
                            100
                          }
                          onCommit={(pct) => setCell(s.sourceId, p, pct)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="mt-4 border-t pt-3">
          <LeverHint hint="HONEST assumption knob: the ledger cannot trace which dollar funds which bet, so this is the planned share of each reward $ that gets re-wagered (and would have re-earned programs).">
            <LeverSlider
              label="Re-wager assumption"
              valueLabel={formatPct(reWagerRate)}
              value={reWagerRate * 100}
              onValueChange={(pct) =>
                setLevers((s) => ({
                  ...s,
                  matrixReWagerRate: clamp(pct / 100, 0, 1),
                }))
              }
              min={0}
              max={100}
              step={1}
              baselineMarker={100}
              baselineLabel="100% = every reward $ re-wagered"
              preciseInput={{ unit: "percent", decimals: 0 }}
            />
          </LeverHint>
        </div>
      </StatPanel>

      <StatPanel title="Projected savings" icon={PiggyBank} accent="emerald">
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: what we save by stopping reward money from earning
          rewards again.
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          savings(program) = program cost-rate × re-wager assumption ×
          de-credited reward volume. $0 while every cell sits at 100%.
        </p>
        {rates.map((r) => {
          const s = programSavingsUsd(
            r,
            reWagerRate,
            sources,
            levers.matrixCells,
          );
          return (
            <PanelRow
              key={r.programId}
              label={`${CREDIT_MATRIX_PROGRAM_LABELS[r.programId]} · ${r.source}`}
              value={
                <span
                  className={`tabular-nums ${
                    s > 0 ? TEXT_TONE.emerald : "text-muted-foreground"
                  }`}
                >
                  {s > 0 ? `−${formatCurrency(s)} cost` : formatCurrency(0)}
                </span>
              }
            />
          );
        })}
        <div className="mt-2 space-y-0.5 border-t pt-2">
          <PanelRow
            label="Total window savings"
            value={
              <span
                className={`font-semibold tabular-nums ${
                  totalSavings > 0 ? TEXT_TONE.emerald : "text-muted-foreground"
                }`}
              >
                {formatCurrency(totalSavings)}
              </span>
            }
          />
          <PanelRow
            label="≈ Monthly savings"
            value={
              <span
                className={`tabular-nums ${
                  monthlySavings > 0
                    ? TEXT_TONE.emerald
                    : "text-muted-foreground"
                }`}
              >
                {formatCurrency(monthlySavings)}
              </span>
            }
          />
        </div>
      </StatPanel>
    </div>
  );
}

/**
 * One matrix cell: a compact 0–100 credit-% input. Free typing in local
 * state, commit on blur / Enter (clamped); invalid entries revert. Carries
 * the stable `data-testid="credit-matrix-cell"` hook the e2e contract keys
 * on, plus a per-cell aria-label.
 */
function MatrixCellInput({
  sourceId,
  sourceLabel,
  programId,
  valuePct,
  onCommit,
}: {
  sourceId: string;
  sourceLabel: string;
  programId: CreditMatrixProgramId;
  valuePct: number;
  onCommit: (pct: number) => void;
}) {
  const canonical = formatCellPct(valuePct);
  const [text, setText] = React.useState(canonical);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setText(canonical);
  }, [canonical, focused]);

  const commit = (raw: string) => {
    const parsed = Number(raw.trim().replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setText(canonical);
      return;
    }
    const clamped = Math.min(100, Math.max(0, parsed));
    onCommit(clamped);
    setText(formatCellPct(clamped));
  };

  const isDefault = valuePct >= 100;

  return (
    <div className="relative ml-auto w-[4.5rem]">
      <Input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        data-testid="credit-matrix-cell"
        aria-label={`${sourceLabel} ${CREDIT_MATRIX_PROGRAM_LABELS[programId]} credit %`}
        data-source={sourceId}
        data-program={programId}
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`h-7 min-h-7 w-full py-0 pl-2 pr-5 text-right text-xs leading-none tabular-nums ${
          isDefault ? "text-muted-foreground" : TEXT_TONE.emerald
        }`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] font-medium text-muted-foreground">
        %
      </span>
    </div>
  );
}

/** Trim a credit % for the box ("100", "37.5"). */
function formatCellPct(pct: number): string {
  if (!Number.isFinite(pct)) return "100";
  const fixed = pct.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
