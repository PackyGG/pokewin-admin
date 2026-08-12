export type PnlMultiplierFundingSnapshot = {
  snapshot_version: 1;
  multiplier_bps: number;
  withdrawable_bps: number;
  required_deposit_usd: string;
  wager_requirement_bps: number;
  max_total_wager_usd: string | null;
  max_payout_usd: string | null;
  min_session_duration_seconds: number;
  min_bet_count: number;
  min_wager_to_funding_ratio_bps: number;
  kick_vod_required: boolean;
  auto_renew: boolean;
  backend_terms_version: string;
  backend_record_version: number;
};

type MultiplierContract = Omit<
  PnlMultiplierFundingSnapshot,
  "snapshot_version" | "backend_terms_version" | "backend_record_version"
> & {
  terms_version: string;
  version: number;
};

/** Freeze the canonical backend contract in the ADMIN-owned P&L row. */
export function snapshotPnlMultiplierFunding(
  deal: MultiplierContract,
): PnlMultiplierFundingSnapshot {
  return {
    snapshot_version: 1,
    multiplier_bps: deal.multiplier_bps,
    withdrawable_bps: deal.withdrawable_bps,
    required_deposit_usd: deal.required_deposit_usd,
    wager_requirement_bps: deal.wager_requirement_bps,
    max_total_wager_usd: deal.max_total_wager_usd,
    max_payout_usd: deal.max_payout_usd,
    min_session_duration_seconds: deal.min_session_duration_seconds,
    min_bet_count: deal.min_bet_count,
    min_wager_to_funding_ratio_bps: deal.min_wager_to_funding_ratio_bps,
    kick_vod_required: deal.kick_vod_required,
    auto_renew: deal.auto_renew,
    backend_terms_version: deal.terms_version,
    backend_record_version: deal.version,
  };
}

/**
 * Read only the immutable ADMIN snapshot. Historical rows without one must
 * never silently inherit later backend edits.
 */
export function pnlFundingMultiplierBps(
  fundingConfig: Record<string, unknown>,
): number | null {
  const snapshot = fundingConfig.multiplier_terms_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const fields = snapshot as Record<string, unknown>;
  const value = fields.multiplier_bps;
  const validVersion = fields.snapshot_version === 1
    && typeof fields.backend_terms_version === "string"
    && fields.backend_terms_version.length > 0
    && typeof fields.backend_record_version === "number"
    && Number.isInteger(fields.backend_record_version)
    && fields.backend_record_version >= 1;
  return validVersion
    && typeof value === "number"
    && Number.isInteger(value)
    && value >= 20_000
    ? value
    : null;
}
