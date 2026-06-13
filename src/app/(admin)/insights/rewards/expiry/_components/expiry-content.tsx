import Link from "next/link";
import {
  Hourglass,
  Timer,
  CalendarClock,
  TrendingDown,
  UserMinus,
  Info,
  Settings2,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getRakebackExpiry,
  type RakebackExpiryWindow,
} from "@/lib/queries/insights-rewards/expiry";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Reward-expiry content (RAKEBACK-SCOPED MVP).
 *
 * Three truthful sections:
 *   1. Model-gap notice — the at-risk / lost-unclaimed view CANNOT be
 *      measured from persisted data (pending rakeback is live-computed,
 *      never stored). Stated up front so no one reads a zero as "nothing
 *      is evaporating".
 *   2. Live expiry config — the claim window per rakeback type
 *      (rakeback_config.expiration_days), the lever set on
 *      /security/reward-expiry.
 *   3. Forfeited-by-lapsing — the best AVAILABLE behavioural proxy for
 *      program value the user walked away from (claimed prior window,
 *      stopped). Framed AMBER/NEUTRAL: wasted marketing spend, not a
 *      clean house gain.
 *
 * House-POV colour: forfeited rakeback is not a profit line — it is a
 * program-effectiveness signal → amber. The detail table keeps the
 * forfeited $ rose-tinted because it IS rakeback (a cost family), but the
 * headline framing stays amber.
 */
export async function ExpiryContent({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const res = await safeQuery(
    () => getRakebackExpiry(period),
    null,
    "insights-rewards-expiry",
  );

  if (res.error || !res.data) {
    return (
      <TileErrorFallback
        label="Reward expiry"
        hint="The reward-expiry query failed."
        size="panel"
      />
    );
  }

  const { windows, expirationConfigured, forfeited } = res.data;

  return (
    <div className="space-y-6">
      {/* 1. Model-gap notice */}
      <FadeIn>
        <ModelGapNotice />
      </FadeIn>

      {/* 2. Live expiry config */}
      <FadeIn>
        <SectionHeading
          icon={Settings2}
          title="Live claim windows"
          action={
            <Link
              href="/security/reward-expiry"
              className="text-xs font-medium text-primary hover:underline"
            >
              Configure →
            </Link>
          }
        />
        {!expirationConfigured ? (
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <EmptyState
              icon={Timer}
              title="Expiry windows not configured"
              description="rakeback_config.expiration_days is not present on this database. Claim windows are managed by the backend and not readable here."
              compact
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {windows.map((w) => (
              <ConfigCard key={w.type} window={w} />
            ))}
          </div>
        )}
      </FadeIn>

      {/* 3. Forfeited-by-lapsing proxy */}
      <FadeIn>
        <SectionHeading
          icon={Hourglass}
          title="Forfeited by lapsing"
          action={
            <span className="text-xs text-muted-foreground">
              {insightsRewardsPeriodLabel(period)}
            </span>
          }
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Users who claimed rakeback in the prior-equal window and then
          stopped. Their prior-window rakeback is the closest available read
          on retained-program value the user walked away from — wasted
          marketing spend, not a clean house gain.
        </p>

        {forfeited == null ? (
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <EmptyState
              icon={UserMinus}
              title="Forfeited view needs a finite window"
              description="Pick 24h / 3d / 7d / 30d / 90d — the lapsing signal compares the current window against the prior-equal window."
              compact
            />
          </div>
        ) : forfeited.totalLapsedUsers === 0 ? (
          <div className="mt-3 rounded-2xl border bg-card p-4">
            <EmptyState
              icon={UserMinus}
              title="No lapsed claimants"
              description="Everyone who claimed in the prior-equal window also claimed in the current window."
              compact
            />
          </div>
        ) : (
          <ForfeitedBody forfeited={forfeited} />
        )}
      </FadeIn>
    </div>
  );
}

function ModelGapNotice() {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/15 p-1.5">
          <Info className="size-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-semibold text-amber-700 dark:text-amber-300">
            Rakeback-scoped MVP — &ldquo;at-risk / lost unclaimed&rdquo; is
            not measurable from stored data
          </p>
          <p className="text-muted-foreground">
            Pending rakeback is computed live from each user&rsquo;s wager
            history at claim time and is never persisted. A{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              rakeback_claims
            </code>{" "}
            row only exists once a user claims (every row has{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              claimed_at
            </code>{" "}
            set). So the dollar amount that expires{" "}
            <span className="font-medium">unclaimed</span> isn&rsquo;t
            readable here — surfacing it would require a new backend signal.
            This page shows what IS truthful: the live claim windows and a
            behavioural &ldquo;forfeited by lapsing&rdquo; proxy.
          </p>
          <p className="text-xs text-muted-foreground">
            Follow-up: race / leaderboard / balance rewards have claim
            windows too, but no admin-readable claim-linkage to separate
            &ldquo;expired unclaimed&rdquo; from &ldquo;never earned&rdquo; —
            not fabricated here.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConfigCard({ window: w }: { window: RakebackExpiryWindow }) {
  const expires = w.expirationDays != null && w.expirationDays > 0;
  return (
    <StatPanel title={w.displayName} icon={CalendarClock} accent="blue">
      <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums sm:text-3xl">
        {w.expirationDays == null
          ? "—"
          : w.expirationDays === 0
            ? "Never"
            : `${w.expirationDays}d`}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {expires
          ? "Claim window after the period ends"
          : w.expirationDays === 0
            ? "Claims never expire"
            : "Window not configured"}
      </p>
      <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
        <PanelRow
          label="Status"
          value={w.enabled ? "Enabled" : "Disabled"}
        />
        <PanelRow label="Type" value={w.type} />
      </div>
    </StatPanel>
  );
}

function ForfeitedBody({
  forfeited,
}: {
  forfeited: NonNullable<
    Awaited<ReturnType<typeof getRakebackExpiry>>["forfeited"]
  >;
}) {
  return (
    <div className="mt-3 space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Lapsed claimants"
          value={formatNumber(forfeited.totalLapsedUsers)}
          sub="Claimed prior window only"
          icon={UserMinus}
          accent="amber"
        />
        <KpiTile
          label="Forfeited value"
          value={formatCurrency(forfeited.totalForfeitedValue)}
          sub="Prior-window rakeback walked away from"
          icon={TrendingDown}
          accent="amber"
        />
        <KpiTile
          label="Avg per lapsed user"
          value={formatCurrency(
            forfeited.totalLapsedUsers > 0
              ? forfeited.totalForfeitedValue / forfeited.totalLapsedUsers
              : 0,
          )}
          sub="Forfeited ÷ lapsed users"
          icon={Hourglass}
          accent="amber"
        />
      </div>

      {forfeited.byType.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {forfeited.byType.map((t) => (
            <StatPanel
              key={t.type}
              title={`${t.type} rakeback`}
              icon={CalendarClock}
              accent="amber"
            >
              <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-amber-600 dark:text-amber-400 sm:text-3xl">
                {formatCurrency(t.forfeitedValue)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Forfeited prior-window value
              </p>
              <div className="mt-3 space-y-0.5 border-t pt-3 text-sm">
                <PanelRow
                  label="Lapsed claims"
                  value={formatNumber(t.lapsedClaims)}
                />
              </div>
            </StatPanel>
          ))}
        </div>
      )}

      <div>
        <SectionHeading
          icon={UserMinus}
          title="Top 25 lapsed by prior rakeback"
        />
        <div className="mt-3 overflow-hidden rounded-2xl border bg-card">
          <div className="max-h-[34rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border/40">
                  <th className="px-4 py-2 text-left sm:px-5">User</th>
                  <th className="px-3 py-2 text-right">Prior rakeback</th>
                  <th className="px-3 py-2 text-right">Prior claims</th>
                  <th className="px-3 py-2 text-right">Last claimed</th>
                </tr>
              </thead>
              <tbody>
                {forfeited.sampleUsers.map((u) => (
                  <tr
                    key={u.userId}
                    className="border-t border-border/40 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 sm:px-5">
                      <Link
                        href={`/users/${u.userId}`}
                        className="truncate text-foreground hover:underline"
                      >
                        {u.username ?? u.userId.slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(u.priorRakeback)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(u.priorClaims)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {u.lastClaimedAt ? formatRelative(u.lastClaimedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
