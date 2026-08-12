export const CREATOR_PNL_ATTRIBUTION_LOOKBACK_DAYS = 365;
export const CREATOR_PNL_MAX_FRAME_DAYS = CREATOR_PNL_ATTRIBUTION_LOOKBACK_DAYS;
export const CREATOR_PNL_MAX_MULTIPLIER_BPS = 10_000_000;
export const CREATOR_PNL_MAX_MULTIPLIER_X = CREATOR_PNL_MAX_MULTIPLIER_BPS / 10_000;

const DAY_MS = 86_400_000;

export function creatorPnlFrameDurationDays(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / DAY_MS;
}

export function isCreatorPnlFrameDurationAllowed(startIso: string, endIso: string): boolean {
  const durationDays = creatorPnlFrameDurationDays(startIso, endIso);
  return Number.isFinite(durationDays)
    && durationDays >= 1
    && durationDays <= CREATOR_PNL_MAX_FRAME_DAYS;
}
