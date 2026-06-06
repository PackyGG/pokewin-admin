import { Calculator } from "lucide-react";

import { requireRole } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

import { ProfitableAlgoCalculator } from "./profitable-algo-calculator";

export const metadata = { title: "Profitable Algo · Creator Hub" };

/**
 * Profitable Algo — Deal Profitability calculator (Creator Hub tool).
 *
 * A PURE calculator: no DB read, no MAIN/ADMIN query, no API. It evaluates
 * deal profitability from manager-typed inputs using the owner's exact math
 * (plan: iridescent-mixing-lecun.md, "Profitable Algo"):
 *
 *   Generated Value = WAGER × 0.075
 *   Deal Spend      = MAX WITHDRAW CAP + LB CONTRIBUTION + TIP/SPONSOR ALLOWANCE
 *   Rate of Return  = Generated Value / Deal Spend   (profitable when > 1)
 *   + Performance Forecast (daily/weekly value) and Daily Spend budget.
 *
 * Because there's no data fetch, there's nothing to lazy-load here — the
 * whole tool is a single client island below the hero. ACCESS is gated to
 * admin + creator_manager (same boundary the Hub layout enforces; the page
 * adds the explicit server-side DAL gate per house convention).
 */
export default async function ProfitableAlgoPage() {
  await requireRole(["admin", "creator_manager"]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Calculator}
          accent="emerald"
          title="Profitable Algo"
          subtitle="Deal profitability calculator · math-check a deal before you sign it"
        />
      </PageHero>

      <FadeIn>
        <ProfitableAlgoCalculator />
      </FadeIn>
    </div>
  );
}
