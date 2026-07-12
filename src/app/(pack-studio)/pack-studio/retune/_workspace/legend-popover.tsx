"use client";

import * as React from "react";
import { BookOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Compact legend popover — folds the retired `retune-guide.tsx` content
 * (glossary + house-POV color rule + the "nothing writes until you confirm"
 * fact) into one Popover so the workspace header stays clean. The copy is
 * COPIED (not imported) from the guide: that file is deleted in Push 3.
 */

type LegendTerm = { term: string; def: string };

const LEGEND: LegendTerm[] = [
  {
    term: "House edge",
    def: "Your margin per open: 1 − (expected payout ÷ price). Each pack has its own target — a 10.99% floor plus a small risk premium for pricier / jackpot-heavy packs. Emerald = at or above target; rose = below.",
  },
  {
    term: "Win-rate",
    def: "The share of opens that hit a profit card (value ≥ price). For a tagged pack (%1 / %5 / %10), the target equals the tag.",
  },
  {
    term: "Clean odds",
    def: "Every card's chance is a round, human-readable number on the clean ladder. Clean odds are a MUST to push — the planner moves the pack price inside the allowed band to land them.",
  },
  {
    term: "Near-miss",
    def: "Opens that land just below the price (half-price to full price) — the \"so close\" outcome that keeps a pack from feeling dead.",
  },
  {
    term: "Max-win / Max-mult",
    def: "The single highest card value in the pool (the jackpot), and that value as a multiple of the pack price.",
  },
  {
    term: "CV · Tier (T1–T5)",
    def: "Payout volatility (spread ÷ average), bucketed into tiers: T1 steady → T5 jackpot lottery.",
  },
  {
    term: "Off-tag",
    def: "A tagged pack whose LIVE pool pays a different winner share than its tag says. Pushing the plan fixes it.",
  },
  {
    term: "Plan = write",
    def: "The plan on screen is the exact artifact the Push button writes, pinned by price + pool fingerprint — the server refuses anything else. Nothing changes until you confirm twice.",
  },
];

export function LegendPopover() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="sm">
            <BookOpen className="size-3.5" />
            Legend
          </Button>
        }
      />
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <dl className="grid gap-y-2.5">
          {LEGEND.map((g) => (
            <div key={g.term} className="space-y-0.5">
              <dt className="text-xs font-semibold text-foreground">
                {g.term}
              </dt>
              <dd className="text-xs leading-relaxed text-muted-foreground">
                {g.def}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          Colors are from the{" "}
          <span className="font-medium text-foreground">house</span>&apos;s
          point of view:{" "}
          <span className="font-medium text-rose-600 dark:text-rose-400">
            rose
          </span>{" "}
          = the player wins more / the house gives away margin;{" "}
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            emerald
          </span>{" "}
          = healthy for the house;{" "}
          <span className="font-medium text-blue-600 dark:text-blue-400">
            blue
          </span>{" "}
          = neutral.
        </p>
      </PopoverContent>
    </Popover>
  );
}
