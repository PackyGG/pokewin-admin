import Link from "next/link";
import { Trophy, ArrowRight, AlertTriangle } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { formatNumber, formatCurrency, formatDate } from "@/lib/utils/format";
import { getLeaderboardSnipers } from "@/lib/queries/insights-streamers/leaderboard-sniping";
import { periodLabel, type StreamerPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Leaderboard Sniping tab — race winners whose code history shows a
 * "switched in to win, switched back" pattern.
 *
 * Each row is a race claim by a user who has used 2+ DISTINCT codes
 * lifetime. The columns show:
 *   - Code at claim       — the active code at the moment of the win
 *   - Most recent code    — the user's current/latest code
 *   - Switched away flag  — when those two codes differ
 *
 * The "Switched away" badge is the high-confidence sniping signal — the
 * user used code X to win the race, then moved to code Y after collecting.
 *
 * Per CLAUDE.md House-POV: a race prize is money OUT of the house
 * (user gains, we pay), so the prize is rose. Position is neutral text.
 */
export async function LeaderboardSnipingTab({
  period,
}: {
  period: StreamerPeriod;
}) {
  const { data: rows, error } = await safeQuery(
    () => getLeaderboardSnipers(period),
    [] as Awaited<ReturnType<typeof getLeaderboardSnipers>>,
    "insights-streamers.leaderboardSnipers",
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Streamers — Leaderboard Sniping"
        hint="The leaderboard sniping query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const switchedAway = rows.filter((r) => r.switchedAway).length;
  const totalPrize = rows.reduce((acc, r) => acc + r.prizeUsd, 0);
  const switchedPrize = rows
    .filter((r) => r.switchedAway)
    .reduce((acc, r) => acc + r.prizeUsd, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="Suspicious Claims"
            value={formatNumber(rows.length)}
            sub="Race wins by multi-code users"
            icon={Trophy}
            accent="amber"
          />
          <KpiTile
            label="Confirmed Snipes"
            value={formatNumber(switchedAway)}
            sub="Switched code after winning"
            icon={AlertTriangle}
            accent="rose"
          />
          <KpiTile
            label="Sniped Prize Total"
            value={formatCurrency(switchedPrize)}
            sub="Out of the house via snipes"
            icon={Trophy}
            accent="rose"
          />
          <KpiTile
            label="All Flagged Prizes"
            value={formatCurrency(totalPrize)}
            sub={`in ${periodLabel(period).toLowerCase()}`}
            icon={Trophy}
            accent="rose"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={Trophy}
          title={`Leaderboard Snipers — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Race</TableHead>
                <TableHead className="text-right">Pos.</TableHead>
                <TableHead className="text-right">Prize</TableHead>
                <TableHead>Code at Claim</TableHead>
                <TableHead>Most Recent Code</TableHead>
                <TableHead className="text-right"># Codes</TableHead>
                <TableHead className="w-28">Signal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No race claims by multi-code users in this window.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, idx) => (
                  <TableRow key={`${r.userId}-${r.raceType}-${r.racePeriodStart}-${idx}`}>
                    <TableCell>
                      <Link
                        href={`/users/${r.userId}`}
                        className="font-medium hover:underline"
                      >
                        {r.username ?? r.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="capitalize">{r.raceType}</span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        {formatDate(r.racePeriodStart)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      #{r.position}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                      −{formatCurrency(r.prizeUsd)}
                    </TableCell>
                    <TableCell>
                      {r.codeAtClaim ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {r.codeAtClaim}
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          no acu within 14d
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.mostRecentCode ? (
                        <span className="inline-flex items-center gap-1">
                          {r.switchedAway && (
                            <ArrowRight className="size-3 text-rose-500" />
                          )}
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {r.mostRecentCode}
                          </code>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          no activity after claim
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.totalCodesUsed)}
                    </TableCell>
                    <TableCell>
                      {r.switchedAway ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400"
                          title="Code at claim differs from current code"
                        >
                          <AlertTriangle className="size-3" />
                          Switched away
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-600 dark:text-cyan-400">
                          Multi-code
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
    </div>
  );
}
