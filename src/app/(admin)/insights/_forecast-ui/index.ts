/**
 * Public surface of the SHARED, reward-agnostic forecast UI kit.
 *
 * All client components ("use client"). The pieces are CONFIG-DRIVEN: each
 * takes a reward's `ForecastConfig` (or serializable slices of it) so the same
 * simulator renders any reward's forecast. House-POV colors + dark mode are
 * preserved in every piece (CLAUDE.md).
 *
 * Data-flow contract: a reward's SERVER tab fetches the real baseline and
 * renders a per-reward CLIENT wrapper that imports the reward's config module
 * and mounts `<ForecastSimulator config={...} realBaseline={...} />`. The config
 * (which holds the pure `simulate` fn) is NEVER passed from a server component
 * as a prop — only the serializable baseline + period are.
 */

export { ForecastSimulator } from "./forecast-simulator";
export type { ForecastSimulatorProps } from "./forecast-simulator";

export { ForecastControls } from "./forecast-controls";
export type { ForecastControlsProps } from "./forecast-controls";

export { ForecastComparisonTable } from "./forecast-comparison-table";
export type { ComparisonRow } from "./forecast-comparison-table";

export {
  CostOverTimeChart,
  CumulativeCostChart,
  SavingsByScenarioChart,
  AbuseLeakageChart,
  SegmentContributionChart,
  SensitivityChart,
  segmentHex,
} from "./forecast-charts";
export type { SensitivityPoint } from "./forecast-charts";

export { formatLeverValue, shortScenarioLabel } from "./forecast-format";

export {
  encodeForecastState,
  decodeForecastState,
} from "./forecast-state";
export type { AnyAssumptions, ForecastUrlState } from "./forecast-state";
