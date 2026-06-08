"use client";

import { Gem, Banknote, Sparkles } from "lucide-react";

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
    title: "Live withdrawal split",
    blurb: "Replace estimated balance-withdrawal share with ledger-derived split.",
    tag: "Withdrawals",
  },
  {
    icon: Sparkles,
    title: "Elastic wager volume",
    blurb: "Model second-order volume effects when shard earn rate changes.",
    tag: "Model",
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
