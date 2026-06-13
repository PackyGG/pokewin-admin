"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  computeOddsForTargetEv,
  suggestedPriceFromEv,
} from "@/app/(admin)/insights/edge-calc/math";
import { formatCurrency } from "@/lib/utils/format";
import type { SortableCard } from "./sortable-card-table";

/**
 * Shard-pack-only control: enter a target EV per open and distribute odds
 * across the current card pool to hit it.
 */
export function TargetEvOddsSetter({
  cards,
  cardsPerOpen,
  onApplyOdds,
  onPriceDerived,
  disabled,
}: {
  cards: SortableCard[];
  cardsPerOpen: number;
  onApplyOdds: (odds: number[]) => void;
  onPriceDerived?: (price: number) => void;
  disabled?: boolean;
}) {
  const [targetEv, setTargetEv] = useState("");

  function handleSet() {
    const parsed = parseFloat(targetEv);
    const result = computeOddsForTargetEv(cards, parsed, cardsPerOpen);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    onApplyOdds(result.odds);
    const derivedPrice = suggestedPriceFromEv(parsed);
    if (derivedPrice > 0) onPriceDerived?.(derivedPrice);
    toast.success(`Odds set for ${formatCurrency(parsed)} EV/open`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label>Target EV (USD)</Label>
        <Input
          type="number"
          value={targetEv}
          onChange={(e) => setTargetEv(e.target.value)}
          placeholder="0.001 – 5000"
          min="0.001"
          max="5000"
          step="0.001"
          className="w-44"
          disabled={disabled}
        />
      </div>
      <Button
        type="button"
        variant="secondary"
        onClick={handleSet}
        disabled={disabled || cards.length === 0}
      >
        Set
      </Button>
    </div>
  );
}
