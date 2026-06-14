import Link from "next/link";
import { Zap, AlertTriangle, Info, Timer, Percent, TrendingUp } from "lucide-react";
import {
  SectionHeading,
  StatPanel,
  KpiTile,
  PanelRow,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  INSTANT_CLAIM_PERIODS,
  instantClaimPeriodLabel,
  type InstantClaimPeriod,
  type InstantClaimConfig,
  type InstantClaimUsage,
} from "@/lib/queries/rakeback-instant-claim";

/**
 * Instant-claim (early-claim / pre-claim) section for the rakeback Config
 * tab. Two stacked blocks:
 *   1. Config status — current per-cadence early-claim payout % + cooldown,
 *      READ-ONLY. Editing requires a backend admin endpoint that is not
 *      deployed (all `/admin/rakeback*` config routes 404), so we surface
 *      the current state and say so plainly rather than ship a fake toggle.
 *   2. Usage — how much the instant-claim flow got used over the active
 *      window (count + $ + share of claims that were instant).
 *
 * House-POV finance colors: every rakeback dollar paid to users is a house
 * cost → rose. The "share instant" ratios are neutral behavior → blue.
 *
 * Server component — period selector is a set of `?icPeriod=` links so only
 * the ACTIVE window is queried per request (active-timeframe-only).
 */

function pct01(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function PeriodTabs({ active }: { active: InstantClaimPeriod }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
      {INSTANT_CLAIM_PERIODS.map((p) => (
        <Link
          key={p}
          href={`/rewards/rakeback?tab=config&icPeriod=${p}`}
          scroll={false}
          className={cn(
            "inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            active === p
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {instantClaimPeriodLabel(p)}
        </Link>
      ))}
    </div>
  );
}

export function InstantClaimSection({
  config,
  usage,
  period,
}: {
  config: InstantClaimConfig;
  usage: InstantClaimUsage;
  period: InstantClaimPeriod;
}) {
  const featureAbsent = !config.supported && !usage.supported;

  // Defensive degraded state: the early-claim columns are missing on the
  // ACTIVE DB env. On prod the feature is LIVE (columns present, real
  // instant claims) so this never shows there — it only guards an
  // unmigrated env (e.g. a dev DB without the early-claim columns).
  if (featureAbsent) {
    return (
      <div className="space-y-4">
        <SectionHeading icon={Zap} title="Instant claim" />
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">
              Instant-claim data unavailable on this database
            </p>
            <p className="text-amber-600/80 dark:text-amber-400/80">
              The early-claim columns (<code>early_claim_payout_percent</code>,{" "}
              <code>last_preclaim_at</code>) are not present on the active game
              database, so this section can&apos;t load. The feature itself is
              live on production — this only appears if the active DB env is
              missing these columns (e.g. an unmigrated dev database). Switch
              the DB env toggle back to production to view it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={Zap}
        title={
          <span className="flex items-center gap-2">
            Instant claim
            <Badge
              variant="outline"
              className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
            >
              read-only
            </Badge>
          </span>
        }
      />

      {/* ── Config status ──────────────────────────────────────────── */}
      {config.supported && (
        <StatPanel title="Early-claim configuration" icon={Percent} accent="purple">
          <div className="flex items-start gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-2.5 text-[11px] text-blue-600 dark:text-blue-400">
            <Info className="size-3.5 shrink-0 mt-0.5" />
            <p className="text-blue-600/80 dark:text-blue-400/80">
              Instant claim lets users cash out accrued rakeback before the
              period closes, for a discounted payout. These knobs live on the
              backend&apos;s <code>rakeback_config</code> and are not editable
              from the admin yet — there is no backend admin endpoint for the
              early-claim percentage / cooldown (the existing toggles cover
              rate, expiry and enabled only). Values shown are the current
              live config.
            </p>
          </div>

          <div className="mt-3 space-y-3">
            {config.tiers.map((t) => (
              <div
                key={t.type}
                className="rounded-lg border bg-card/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{t.type}</Badge>
                    <span className="text-sm font-medium">{t.displayName}</span>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      t.enabled
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-muted-foreground/30 text-muted-foreground",
                    )}
                  >
                    {t.enabled ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <PanelRow
                  label="Instant payout"
                  value={`${t.earlyClaimPayoutPercent.toFixed(0)}% of accrued`}
                />
                <PanelRow
                  label="Cooldown"
                  value={
                    <span className="flex items-center gap-1">
                      <Timer className="size-3 text-muted-foreground" />
                      {formatNumber(t.earlyClaimCooldownSeconds)}s
                    </span>
                  }
                />
              </div>
            ))}
          </div>
        </StatPanel>
      )}

      {/* ── Usage ──────────────────────────────────────────────────── */}
      {usage.supported ? (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Usage · {instantClaimPeriodLabel(period)}
            </p>
            <PeriodTabs active={period} />
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label="Instant claims"
              value={formatNumber(usage.instantCount)}
              sub={`of ${formatNumber(usage.totalClaimCount)} claims`}
              icon={Zap}
              accent="blue"
            />
            <KpiTile
              label="Instant payout"
              value={formatCurrency(usage.instantAmountUsd)}
              sub={`of ${formatCurrency(usage.totalAmountUsd)} paid`}
              icon={TrendingUp}
              accent="rose"
            />
            <KpiTile
              label="Share (by count)"
              value={pct01(usage.instantShareByCount)}
              sub="claims that were instant"
              icon={Percent}
              accent="blue"
            />
            <KpiTile
              label="Share (by $)"
              value={pct01(usage.instantShareByAmount)}
              sub="of rakeback $ paid"
              icon={Percent}
              accent="blue"
            />
          </div>

          {usage.byType.length > 0 && (
            <StatPanel
              title={`Instant claims by cadence · ${instantClaimPeriodLabel(period)}`}
              icon={Zap}
              accent="blue"
            >
              {usage.byType.map((t) => (
                <PanelRow
                  key={t.type}
                  label={`${t.type} · ${formatNumber(t.instantCount)} claim${t.instantCount === 1 ? "" : "s"}`}
                  value={formatCurrency(t.instantAmountUsd)}
                  valueClassName="text-rose-600 dark:text-rose-400"
                />
              ))}
            </StatPanel>
          )}

          {usage.totalClaimCount === 0 && (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No settled rakeback claims in this window.
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <p className="text-amber-600/80 dark:text-amber-400/80">
            Usage metrics can&apos;t load on this database — the{" "}
            <code>last_preclaim_at</code> column that flags an instant claim is
            not present on the active game DB (it is on production; this only
            shows on an unmigrated env).
          </p>
        </div>
      )}
    </div>
  );
}
