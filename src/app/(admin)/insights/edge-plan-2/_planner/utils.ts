import { formatCurrency } from "@/lib/utils/format";

/** Slider bounds for “wager per gem” (inverse of shards-per-$1 rate). */
export const MIN_WAGER_PER_GEM_USD = 0.1;
export const MAX_WAGER_PER_GEM_USD = 1000;
export const DEFAULT_WAGER_PER_GEM_USD = 10;

export function multLabel(m: number): string {
  return `${m.toFixed(2)}×`;
}

export function formatEvUsd(n: number): string {
  if (n >= 100) return formatCurrency(n);
  return `$${n.toFixed(2)}`;
}

/** Convert internal shards-per-$1 rate to USD wager required for one gem. */
export function wagerPerGemFromShardsPerDollar(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return MAX_WAGER_PER_GEM_USD;
  return Math.min(MAX_WAGER_PER_GEM_USD, Math.max(MIN_WAGER_PER_GEM_USD, 1 / rate));
}

/** Convert USD wager-per-gem (UI) back to internal shards-per-$1 rate. */
export function shardsPerDollarFromWagerPerGem(wagerPerGemUsd: number): number {
  if (!Number.isFinite(wagerPerGemUsd) || wagerPerGemUsd >= MAX_WAGER_PER_GEM_USD) return 0;
  if (wagerPerGemUsd <= MIN_WAGER_PER_GEM_USD) return 10;
  return Math.min(10, Math.max(0, 1 / wagerPerGemUsd));
}

export function wagerPerGemLabel(wagerPerGemUsd: number): string {
  if (!Number.isFinite(wagerPerGemUsd) || wagerPerGemUsd >= MAX_WAGER_PER_GEM_USD) {
    return "No earn";
  }
  return `${formatCurrency(wagerPerGemUsd)} / gem`;
}

export const EMERALD = "text-emerald-600 dark:text-emerald-400";
export const ROSE = "text-rose-600 dark:text-rose-400";
