"use client";

import {
  Banknote,
  Gem,
  Gift,
  Sparkles,
  Ticket,
  Zap,
} from "lucide-react";

import { StatPanel } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";

const IDEAS = [
  {
    icon: Gem,
    title: "Shard pack catalog sync",
    blurb: "Wire live shard prices + redemption counts when backend ships.",
    tag: "Shards",
  },
  {
    icon: Banknote,
    title: "Elastic wager volume",
    blurb: "Model second-order volume when shard earn or house edge changes.",
    tag: "Model",
  },
  {
    icon: Sparkles,
    title: "Security config mirror",
    blurb: "Read-only ticks from /security wager-req + leaderboard weights.",
    tag: "Withdrawals",
  },
  {
    icon: Gift,
    title: "Promo cap & gift cards",
    blurb: "Dedicated levers for promo-code budgets and gift-card issuance.",
    tag: "Rewards",
  },
  {
    icon: Ticket,
    title: "Login streak rewards",
    blurb: "Model retention streak payouts as a separate cost bucket.",
    tag: "Rewards",
  },
  {
    icon: Zap,
    title: "Config export / compare",
    blurb: "Side-by-side diff of two saved configs with delta table.",
    tag: "UX",
  },
] as const;

export function IdeasSection() {
  return (
    <StatPanel title="Future levers" icon={Sparkles} accent="cyan">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {IDEAS.map((idea) => {
          const Icon = idea.icon;
          return (
            <div
              key={idea.title}
              className="rounded-xl border bg-background/40 p-4 space-y-2"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-violet-500" />
                <span className="text-sm font-semibold">{idea.title}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {idea.blurb}
              </p>
              <Badge variant="outline" className="text-[10px]">
                {idea.tag}
              </Badge>
            </div>
          );
        })}
      </div>
    </StatPanel>
  );
}
