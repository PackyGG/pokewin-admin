"use client";

import * as React from "react";
import { Calculator } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils/format";
import { withdrawalRequiredWagerUsd } from "../../_model-v2";

/**
 * WithdrawalExample — worked withdrawal wager-rule calculator (display-only,
 * NO $ projection). Shows, for an editable example deposit, the wager
 * required in each game mode to unlock a withdrawal at that mode's weight:
 *
 *   required = deposit ÷ weight
 *
 * Canonical example (owner spec): deposit $100 → wager $100 in packs &
 * battles (100% weight) = done; on upgrader at 50% weight it takes $200.
 */
export function WithdrawalExample({
  packBattleWeight,
  upgraderWeight,
  upgraderAvailable = true,
}: {
  /** Packs + battles wager weight (0..1). */
  packBattleWeight: number;
  /** Upgrader wager weight (0..1). */
  upgraderWeight: number;
  /** False when the baseline has no upgrader data (row stays, marked). */
  upgraderAvailable?: boolean;
}) {
  const [depositInput, setDepositInput] = React.useState("100");
  const parsed = Number(depositInput);
  const depositUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  const modes: {
    key: string;
    label: string;
    weight: number;
    available: boolean;
  }[] = [
    {
      key: "packs-battles",
      label: "Packs & battles",
      weight: packBattleWeight,
      available: true,
    },
    {
      key: "upgrader",
      label: "Upgrader",
      weight: upgraderWeight,
      available: upgraderAvailable,
    },
  ];

  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Calculator className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">Worked example</span>
        <Badge variant="outline" className="text-[10px]">
          display-only · no $ projection
        </Badge>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Label
          htmlFor="withdrawal-example-deposit"
          className="text-[11px] text-muted-foreground"
        >
          Example deposit
        </Label>
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            $
          </span>
          <Input
            id="withdrawal-example-deposit"
            type="number"
            inputMode="decimal"
            min={0}
            step={10}
            value={depositInput}
            onChange={(e) => setDepositInput(e.target.value)}
            className="h-7 w-28 pl-6 text-xs tabular-nums"
          />
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {modes.map((m) => {
          const required =
            depositUsd > 0
              ? withdrawalRequiredWagerUsd(depositUsd, m.weight)
              : null;
          const multiple = m.weight > 0 ? 1 / m.weight : null;
          return (
            <div
              key={m.key}
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <span className="flex items-center gap-1.5 text-muted-foreground">
                {m.label}
                <Badge variant="outline" className="text-[10px] tabular-nums">
                  {(m.weight * 100).toFixed(0)}% weight
                </Badge>
                {!m.available && (
                  <Badge variant="outline" className="text-[10px]">
                    no data
                  </Badge>
                )}
              </span>
              <span className="tabular-nums font-medium">
                {depositUsd <= 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : required == null ? (
                  <span className="text-muted-foreground">
                    never unlocks (0% weight)
                  </span>
                ) : (
                  <>
                    wager {formatCurrency(required)}
                    {multiple != null && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({multiple.toFixed(multiple % 1 === 0 ? 0 : 2)}× the
                        deposit)
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Deposit $100 → wager $100 on packs & battles at 100% weight and the
        withdrawal unlocks; on upgrader at 50% weight the same deposit takes
        $200 of wager. Lower weights make a mode count less toward the unlock
        requirement.
      </p>
    </div>
  );
}
