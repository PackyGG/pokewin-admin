import { safeQuery } from "@/lib/errors/safe-query";
import {
  EMPTY_KENO_DASHBOARD,
  getKenoDashboard,
} from "@/lib/queries/keno";
import { KenoOddsExplorer } from "./odds-explorer";

export async function KenoOddsTab() {
  const { data, error, kind } = await safeQuery(
    getKenoDashboard,
    EMPTY_KENO_DASHBOARD,
    "keno.odds",
    10_000,
  );

  return (
    <KenoOddsExplorer
      observations={data.payoutObservations}
      evidenceUnavailable={Boolean(error || kind)}
    />
  );
}
