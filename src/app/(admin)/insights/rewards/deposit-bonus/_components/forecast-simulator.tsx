"use client";

import { ForecastSimulator } from "../../../_forecast-ui";
import {
  DEPOSIT_BONUS_BASELINE_NOTE,
  DEPOSIT_BONUS_FORECAST_CONFIG,
  type ForecastBaseline,
} from "../_forecast";

/**
 * Deposit-bonus forecast island — the thin CLIENT wrapper.
 *
 * This is the per-reward boundary that lets the GENERIC, config-driven
 * `ForecastSimulator` (in `_forecast-ui`) run without ever crossing the Next 15
 * RSC boundary with a function prop: because THIS module is `"use client"`, it
 * imports the deposit-bonus `ForecastConfig` (which carries the pure `simulate`
 * fn) directly as a module and hands it to the shared island in the client
 * tree. The server tab (`forecast-tab.tsx`) only passes the serializable
 * `realBaseline` + `period` down to here.
 *
 * Every other reward provides an identical 10-line wrapper importing its own
 * config — this is the recipe the fan-out wave follows.
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
      config={DEPOSIT_BONUS_FORECAST_CONFIG}
      realBaseline={realBaseline}
      period={period}
      baselineNote={DEPOSIT_BONUS_BASELINE_NOTE}
    />
  );
}
