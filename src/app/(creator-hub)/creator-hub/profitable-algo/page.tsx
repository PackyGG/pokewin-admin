import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { FadeIn } from "@/components/fade-in";

import {
  ProfitableAlgoCalculator,
  type CalculatorInitialValues,
} from "./profitable-algo-calculator";

export const metadata = { title: "ROI Calculator · Creator Hub" };

/**
 * ROI Calculator (Profitable Algo route) — deal profitability tool.
 *
 * A PURE calculator: no DB read, no MAIN/ADMIN query, no API. It evaluates a
 * single deal from manager-typed inputs using the canonical
 * `@/lib/deal-economics` math (HOUSE_EDGE, LB_HOUSE_SHARE).
 *
 * The page opens directly with the calculator's SectionHeading — no hero
 * (owner decision). Inputs mirror to `?wager=&cap=&lb=&tip=&days=` so a
 * scenario is shareable; we parse them server-side here as initial state.
 * ACCESS is gated to `canAccessCreatorHub` (same boundary the Hub layout
 * enforces; the page adds the explicit server-side gate).
 */
export default async function ProfitableAlgoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCreatorHubPageAccess();
  const sp = await searchParams;

  // Only accept currency-ish strings (digits, dot, comma, $) — anything else
  // is dropped so junk params can't land in the inputs. The client `num()`
  // sanitizer still guards the math itself.
  const pick = (key: string): string => {
    const raw = sp[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") return "";
    return /^[\d.,$\s]{1,20}$/.test(value) ? value : "";
  };

  const initial: CalculatorInitialValues = {
    wager: pick("wager"),
    cap: pick("cap"),
    lb: pick("lb"),
    tip: pick("tip"),
    days: pick("days"),
  };

  return (
    <div className="space-y-6">
      <FadeIn>
        <ProfitableAlgoCalculator initial={initial} />
      </FadeIn>
    </div>
  );
}
