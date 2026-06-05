/**
 * recommend.ts — deposit-bonus re-export of the SHARED, reward-agnostic
 * recommendation summarizer.
 *
 * The recommendation logic (argmax/argmin over the generic `SimulationResult`
 * shape) is identical for every reward, so it now lives in the shared engine
 * kit (`insights/_forecast-engine/recommend.ts`). This thin re-export keeps the
 * deposit-bonus engine surface (`./recommend`, the `index.ts` barrel, and the
 * `__checks__/run.ts` import) unchanged.
 */

export { describeTradeoff, recommend } from "../../../_forecast-engine";
