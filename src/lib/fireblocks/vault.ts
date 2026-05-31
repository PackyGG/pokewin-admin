import "server-only";
import { fireblocksGet } from "./client";

/**
 * Workspace-wide vault balance helpers.
 *
 * `GET /v1/vault/assets` is exactly what we want for a treasury USD
 * tile: Fireblocks aggregates balances per-asset across every vault
 * account in the workspace and returns one row per asset. No pagination
 * needed — the response is a single array sized to the number of
 * distinct assets in the workspace (typically dozens, not thousands).
 *
 * Docs: https://developers.fireblocks.com/reference/getvaultassets
 */

/**
 * Shape returned by Fireblocks for each asset in
 * `/v1/vault/assets`. We only consume a small subset (`id`, `total`,
 * `available`). All numeric balances arrive as strings to preserve
 * precision; the caller decides whether to keep them as strings, parse
 * to Number for USD math, or use a Decimal lib.
 */
type FireblocksVaultAsset = {
  id: string;
  total: string;
  available?: string;
  // Other fields ignored — staked/locked/blockedAmount etc are not used
  // for the treasury headline number. `total` already includes them per
  // Fireblocks' definition.
};

export type WorkspaceAssetBalance = {
  assetId: string;
  /** Native amount as a string — preserves precision for display. */
  total: string;
  /** Available (non-locked) portion, as a string. May be missing. */
  available: string | null;
  /** `total` parsed to Number for USD math. NaN → 0. */
  totalNum: number;
};

/**
 * Pull all aggregate vault balances across the workspace. Returns one
 * row per asset, totals as strings (precision-preserving) plus a parsed
 * Number for downstream USD math.
 *
 * Rows with a parsed total of 0 (Fireblocks sometimes returns assets
 * that are configured but currently empty) are dropped — the dashboard
 * tile only cares about non-zero balances.
 */
export async function getAllVaultBalances(): Promise<WorkspaceAssetBalance[]> {
  const rows = await fireblocksGet<FireblocksVaultAsset[]>("/v1/vault/assets");
  if (!Array.isArray(rows)) return [];

  const out: WorkspaceAssetBalance[] = [];
  for (const r of rows) {
    if (!r || typeof r.id !== "string") continue;
    const totalNum = Number(r.total);
    if (!Number.isFinite(totalNum) || totalNum === 0) continue;
    out.push({
      assetId: r.id,
      total: r.total,
      available: typeof r.available === "string" ? r.available : null,
      totalNum,
    });
  }
  return out;
}
