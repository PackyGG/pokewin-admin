import { InlineError } from "@/components/entity-surface/inline-error";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getDoubleDownLog,
  type DoubleDownPeriod,
  type DoubleDownLog,
} from "@/lib/queries/double-down";
import { DoubleDownLogTable } from "./log-table";

const EMPTY_LOG: DoubleDownLog = {
  rows: [],
  total: 0,
  page: 1,
  perPage: 25,
  totalPages: 1,
};

/**
 * Streamed audit-log section for /insights/double-down. Server-driven
 * pagination + username search; cached + timeout-wrapped in the query module.
 * Renders the client table (which only formats serializable rows — no function
 * props cross the RSC boundary).
 */
export async function DoubleDownLogSection({
  period,
  page,
  perPage,
  search,
}: {
  period: DoubleDownPeriod;
  page: number;
  perPage: number;
  search: string;
}) {
  const { data, error } = await safeQuery(
    () => getDoubleDownLog({ period, page, perPage, search }),
    { ...EMPTY_LOG, page, perPage },
    "insights.doubleDown.log",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <InlineError
        title="Couldn't load the Double Down log"
        hint="This is a load failure, not an empty log — retry to re-run the query."
      />
    );
  }

  return <DoubleDownLogTable log={data} search={search} />;
}
