"use client";

import { ForecastSimulator } from "../../../_forecast-ui";
import {
  MOTHA_BASELINE_NOTE,
  MOTHA_FORECAST_CONFIG,
  type MothaForecastBaseline,
} from "../_forecast";

/**
 * Motha-giveaways forecast island — the thin CLIENT wrapper.
 *
 * This is the per-reward boundary that lets the GENERIC, config-driven
 * `ForecastSimulator` (in `_forecast-ui`) run without ever crossing the Next 15
 * RSC boundary with a function prop: because THIS module is `"use client"`, it
 * imports the motha `ForecastConfig` (which carries the pure `simulate` fn)
 * directly as a module and hands it to the shared island in the client tree.
 * The server tab (`forecast-tab.tsx`) only passes the serializable
 * `realBaseline` (the generic baseline + the real per-channel split) + `period`
 * down to here.
 *
 * Mirrors the deposit-bonus wrapper verbatim — only the imported config differs.
 */
export function ForecastSimulatorIsland({
  realBaseline,
  period,
}: {
  realBaseline: MothaForecastBaseline;
  period: string;
}) {
  return (
    <ForecastSimulator
      config={MOTHA_FORECAST_CONFIG}
      realBaseline={realBaseline}
      period={period}
      baselineNote={MOTHA_BASELINE_NOTE}
    />
  );
}
