"use client";

import {
  Coins,
  Crown,
  Flame,
  Megaphone,
  Sparkles,
  Ticket,
  Trophy,
  Users,
} from "lucide-react";

import { StatPanel } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";

const IDEAS = [
  {
    icon: Ticket,
    title: "Promo code budget cap",
    blurb:
      "Set a monthly ceiling on promo_code_redeemed outflow — currently rolled into “Other reward cost”.",
    tag: "Ledger",
  },
  {
    icon: Coins,
    title: "Gift card redemption limits",
    blurb:
      "Cap gift_card_redeemed velocity or per-user redemption to trim farming leakage.",
    tag: "Ledger",
  },
  {
    icon: Trophy,
    title: "Affiliate leaderboard prizes",
    blurb:
      "Separate prize pool from tier commission — affiliate_leaderboard_prize is already in affiliate cost but could get its own multiplier.",
    tag: "Affiliate",
  },
  {
    icon: Crown,
    title: "VIP / level milestone packs",
    blurb:
      "One-time level-up reward packs (similar to daily tiers) with per-tier EV tuning.",
    tag: "Packs",
  },
  {
    icon: Flame,
    title: "Login streak bonuses",
    blurb:
      "Escalating daily login grants — frequency + EV levers like daily packs.",
    tag: "Retention",
  },
  {
    icon: Users,
    title: "Referral signup pack (non-cash)",
    blurb:
      "Card pack on referral signup distinct from the cash balance_reward_claim lever.",
    tag: "Acquisition",
  },
  {
    icon: Megaphone,
    title: "Waitlist prize pool",
    blurb:
      "waitlist_prize ledger spend — currently in “Other reward cost”; expose as its own planning line.",
    tag: "Ledger",
  },
  {
    icon: Sparkles,
    title: "Manual voucher budget",
    blurb:
      "Admin-issued vouchers + counted balance adjustments — cap the discretionary grant envelope.",
    tag: "Ops",
  },
] as const;

export function PlannerIdeasPanel() {
  return (
    <StatPanel title="Future levers & ideas" icon={Sparkles} accent="cyan">
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Suggested knobs not yet wired into the projection math. Each card names a
        real or plausible reward channel — use them as a backlog when prioritizing
        the next planner controls.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {IDEAS.map((idea) => {
          const Icon = idea.icon;
          return (
            <div
              key={idea.title}
              className="rounded-xl border border-border/60 bg-muted/20 p-3 transition-colors hover:bg-muted/35"
            >
              <div className="flex items-start gap-2.5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10">
                  <Icon className="size-4 text-cyan-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h4 className="text-sm font-semibold">{idea.title}</h4>
                    <Badge variant="outline" className="h-5 text-[10px]">
                      {idea.tag}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {idea.blurb}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </StatPanel>
  );
}
