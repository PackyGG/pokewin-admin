"use client";

import { ForecastSimulator } from "../../../_forecast-ui";
import {
  AFFILIATE_BASELINE_NOTE,
  AFFILIATE_FORECAST_CONFIG,
  type ForecastBaseline,
} from "../_forecast";

/**
 * Affiliate forecast island — the thin CLIENT wrapper.
 *
 * This is the per-reward boundary that lets the GENERIC, config-driven
 * `ForecastSimulator` (in `_forecast-ui`) run without ever crossing the Next 15
 * RSC boundary with a function prop: because THIS module is `"use client"`, it
 * imports the affiliate `ForecastConfig` (which carries the pure `simulate` fn)
 * directly as a module and hands it to the shared island in the client tree. The
 * server tab (`forecast-tab.tsx`) only passes the serializable `realBaseline` +
 * `period` down to here.
 *
 * Identical in shape to the deposit-bonus reference wrapper — only the imported
 * config differs.
 */
export function AffiliateForecastSimulatorIsland({
  realBaseline,
  period,
}: {
  realBaseline: ForecastBaseline;
  period: string;
}) {
  return (
    <ForecastSimulator
      config={AFFILIATE_FORECAST_CONFIG}
      realBaseline={realBaseline}
      period={period}
      baselineNote={AFFILIATE_BASELINE_NOTE}
    />
  );
}
