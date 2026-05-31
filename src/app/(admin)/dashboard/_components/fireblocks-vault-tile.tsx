import { AlertCircle, Vault, Wallet } from "lucide-react";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { AnimatedNumber } from "@/components/animated-number";
import { getFireblocksVaultSnapshot } from "@/lib/queries/fireblocks-balance";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Treasury vault tile — total USD value across every Fireblocks vault
 * account in the workspace + a small per-asset breakdown.
 *
 * House-POV color rule (CLAUDE.md): the vault balance is a NEUTRAL info
 * display — it's our treasury, not user P&L. We use the `blue` accent
 * here, NOT red/green. Don't tint by direction of change.
 *
 * Refresh cadence is owned by the query module (`unstable_cache` with
 * 60s revalidate); this component is plain async — no client polling.
 * The dashboard's existing `<AutoRefresh />` already re-fetches the
 * server route every 60s, so the cache and the page refresh align.
 *
 * Three states the tile renders:
 *   - `unconfigured` → calm muted state ("Set FIREBLOCKS_API_KEY /
 *     FIREBLOCKS_API_SECRET in .env.local").
 *   - `error`        → small AlertCircle + "Couldn't load Fireblocks
 *     balance · retry in 60s". The upstream error body is NEVER shown —
 *     `message` is just an endpoint+status summary.
 *   - `ok`           → headline USD + top-5 asset breakdown.
 */
export async function FireblocksVaultTile() {
  const snap = await getFireblocksVaultSnapshot();

  if (snap.state === "unconfigured") {
    return (
      <StatPanel title="Treasury · Fireblocks" icon={Vault} accent="blue">
        <p className="text-2xl font-bold text-muted-foreground tabular-nums">
          —
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Fireblocks not configured
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Set <code className="font-mono">FIREBLOCKS_API_KEY</code> and{" "}
          <code className="font-mono">FIREBLOCKS_API_SECRET</code> in{" "}
          <code className="font-mono">.env.local</code> to enable.
        </p>
      </StatPanel>
    );
  }

  if (snap.state === "error") {
    return (
      <StatPanel title="Treasury · Fireblocks" icon={Vault} accent="blue">
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              Couldn&rsquo;t load Fireblocks balance
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Retrying in 60s · {snap.message}
            </p>
          </div>
        </div>
      </StatPanel>
    );
  }

  // `ok` state. Sort already done upstream — priced rows desc, unmapped
  // trailing. Take top 5 for the panel breakdown so a workspace with
  // dozens of small dust balances doesn't push the tile to half the
  // screen.
  const TOP_N = 5;
  const top = snap.assets.slice(0, TOP_N);
  const restCount = snap.assets.length - top.length;
  const unmappedCount = snap.unmappedAssetIds.length;

  return (
    <StatPanel title="Treasury · Fireblocks" icon={Vault} accent="blue">
      <div className="space-y-3">
        <div>
          <p className="text-2xl font-bold tabular-nums sm:text-3xl">
            <AnimatedNumber value={snap.totalUsd} format="currency" />
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {formatNumber(snap.assets.length)}{" "}
            {snap.assets.length === 1 ? "asset" : "assets"} across all vault
            accounts
          </p>
        </div>

        {top.length > 0 && (
          <div className="border-t border-border/60 pt-2">
            <div className="mb-1 flex items-center gap-1.5">
              <Wallet className="size-3 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Top holdings
              </span>
            </div>
            {top.map((a) => (
              <PanelRow
                key={a.assetId}
                label={a.assetId}
                value={
                  a.usdValue !== null ? (
                    <span>{formatCurrency(a.usdValue)}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {a.amount.toLocaleString("en-US", {
                        maximumFractionDigits: 6,
                      })}{" "}
                      <span className="text-[10px] uppercase tracking-wider">
                        unpriced
                      </span>
                    </span>
                  )
                }
              />
            ))}
            {(restCount > 0 || unmappedCount > 0) && (
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {restCount > 0 && (
                  <>+{formatNumber(restCount)} more</>
                )}
                {restCount > 0 && unmappedCount > 0 && " · "}
                {unmappedCount > 0 && (
                  <>{formatNumber(unmappedCount)} unmapped</>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </StatPanel>
  );
}

/**
 * Suspense fallback for the tile — mirrors the StatPanel shape so the
 * layout doesn't shift when the real component streams in.
 */
export function FireblocksVaultTileSkeleton() {
  return (
    <div className="surface-sheen surface-raise relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 sm:rounded-2xl">
      <div className="relative space-y-3 p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <div className="size-7 rounded-lg bg-muted/60" />
          <div className="h-3 w-32 rounded bg-muted/60" />
        </div>
        <div className="space-y-2">
          <div className="h-7 w-40 rounded bg-muted/60" />
          <div className="h-3 w-48 rounded bg-muted/40" />
        </div>
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex justify-between">
              <div className="h-3 w-16 rounded bg-muted/40" />
              <div className="h-3 w-20 rounded bg-muted/40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
