import { InlineError } from "@/components/entity-surface/inline-error";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getDoubleDownTimeSeries,
  type DoubleDownPeriod,
} from "@/lib/queries/double-down";
import { DoubleDownCharts } from "./double-down-charts";

/**
 * Streamed charts section for the RIGHT half of /insights/double-down. Fetches
 * the hourly time series (cached + timeout-wrapped) and renders the two
 * stacked client charts (Usage + House P&L). Only a plain serializable array
 * crosses the RSC boundary — no function props.
 */
export async function DoubleDownChartsSection({
  period,
}: {
  period: DoubleDownPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getDoubleDownTimeSeries(period),
    [],
    "insights.doubleDown.timeSeries",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <InlineError
        title="Couldn't load Double Down charts"
        hint="This is a load failure, not an empty window — retry to re-run the aggregate."
      />
    );
  }

  return <DoubleDownCharts data={data} />;
}
