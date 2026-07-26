import { TileErrorFallback } from "@/components/tile-error-fallback";
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

  if (error) {
    return (
      <TileErrorFallback
        label="Keno odds"
        kind={kind ?? undefined}
        size="panel"
      />
    );
  }

  return <KenoOddsExplorer observations={data.payoutObservations} />;
}
