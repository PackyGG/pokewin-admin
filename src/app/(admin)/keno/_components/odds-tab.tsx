import { safeQuery } from "@/lib/errors/safe-query";
import {
  EMPTY_KENO_DASHBOARD,
  getKenoDashboard,
} from "@/lib/queries/keno";
import {
  KENO_DEFAULT_MAX_BET_USD,
  KENO_DEFAULT_MAX_WIN_USD,
} from "@/lib/keno/payouts";
import { getCachedKenoConfig } from "../_cached-reads";
import { KenoOddsExplorer } from "./odds-explorer";

export async function KenoOddsTab() {
  const [dashboardResult, configResult] = await Promise.all([
    safeQuery(
      getKenoDashboard,
      EMPTY_KENO_DASHBOARD,
      "keno.odds",
      10_000,
    ),
    safeQuery(
      getCachedKenoConfig,
      {
        max_bet_usd: KENO_DEFAULT_MAX_BET_USD,
        max_win_usd: KENO_DEFAULT_MAX_WIN_USD,
      },
      "keno.odds.config",
      10_000,
    ),
  ]);

  return (
    <KenoOddsExplorer
      observations={dashboardResult.data.payoutObservations}
      maxBet={configResult.data.max_bet_usd}
      maxWin={configResult.data.max_win_usd}
      evidenceUnavailable={Boolean(
        dashboardResult.error || dashboardResult.kind,
      )}
      configUnavailable={Boolean(configResult.error || configResult.kind)}
    />
  );
}
