import "server-only";

import { cache } from "react";

import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

import {
  listRosterCreators,
  type RosterCreator,
} from "../../creators/_queries/list-roster-creators";

/** Value generated per $ wagered for deal economics (Profitable Algo, 7.5%). */
export const DEAL_VALUE_RATE = 0.075;

export type CompareCreatorRow = RosterCreator & {
  /** Windowed wager × 0.075 — house value generated in the period. */
  generatedValueUsd: number;
  /** Full deal spend ceiling (cap + LB + tip/sponsor). */
  dealSpendUsd: number;
  /** Generated value / deal spend; null when deal spend is zero. */
  rateOfReturn: number | null;
};

export type ComparePickerCreator = Pick<
  RosterCreator,
  "id" | "username" | "email" | "code" | "image"
>;

export type ComparePageData = {
  /** Lightweight roster for the client picker search. */
  pickerCreators: ComparePickerCreator[];
  /** Enriched rows for the selected IDs, in URL order. */
  selected: CompareCreatorRow[];
  /** IDs from the URL that weren't found on the roster. */
  missingIds: string[];
  rosterUnavailable: boolean;
};

function enrichRow(c: RosterCreator): CompareCreatorRow {
  const generatedValueUsd = c.windowedWagerUsd * DEAL_VALUE_RATE;
  const dealSpendUsd = c.dealValue?.dealValueUsd ?? 0;
  const rateOfReturn =
    dealSpendUsd > 0 ? generatedValueUsd / dealSpendUsd : null;
  return { ...c, generatedValueUsd, dealSpendUsd, rateOfReturn };
}

/**
 * Compare page data — reuses the roster's single batched enrichment pass
 * (`listRosterCreators`) then narrows to the 2–3 selected IDs. The picker
 * gets identity fields only; the grid gets full metrics + ROI legs.
 */
export const getComparePageData = cache(async function getComparePageData(
  selectedIds: string[],
  period: DashboardPeriod,
): Promise<ComparePageData> {
  const { creators, rosterUnavailable } = await listRosterCreators(
    period,
    "newest",
  );

  const byId = new Map(creators.map((c) => [c.id, c]));
  const selected: CompareCreatorRow[] = [];
  const missingIds: string[] = [];

  for (const id of selectedIds) {
    const row = byId.get(id);
    if (row) selected.push(enrichRow(row));
    else missingIds.push(id);
  }

  const pickerCreators: ComparePickerCreator[] = creators.map((c) => ({
    id: c.id,
    username: c.username,
    email: c.email,
    code: c.code,
    image: c.image,
  }));

  return { pickerCreators, selected, missingIds, rosterUnavailable };
});
