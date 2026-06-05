"use client";

import { ForecastSimulator } from "../../../_forecast-ui";
import {
  RAKEBACK_FORECAST_CONFIG,
  rakebackBaselineNote,
  type ForecastBaseline,
} from "../_forecast";

/**
 * Rakeback forecast island — the thin CLIENT wrapper.
 *
 * This is the per-reward boundary that lets the GENERIC, config-driven
 * `ForecastSimulator` (in `_forecast-ui`) run without ever crossing the Next 15
 * RSC boundary with a function prop: because THIS module is `"use client"`, it
 * imports the rakeback `ForecastConfig` (which carries the pure `simulate` fn)
 * directly as a module and hands it to the shared island in the client tree.
 * The server tab (`forecast-tab.tsx`) only passes the serializable
 * `realBaseline` (+ the real blended-rate / wager extensions) + `period` down.
 *
 * Identical in shape to the deposit-bonus wrapper — only the imported config
 * differs (this is the recipe the fan-out wave follows).
 */
export function ForecastSimulatorIsland({
  realBaseline,
  period,
}: {
  realBaseline: ForecastBaseline;
  period: string;
}) {
  return (
    <ForecastSimulator
      config={RAKEBACK_FORECAST_CONFIG}
      realBaseline={realBaseline}
      period={period}
      // Real per-cadence policy note (e.g. "Daily 0.25% · Weekly 0.1% · Monthly
      // 0.05%") derived from the config threaded onto the baseline — falls back
      // to a blended-% note when no real config rode in.
      baselineNote={rakebackBaselineNote(realBaseline)}
    />
  );
}
