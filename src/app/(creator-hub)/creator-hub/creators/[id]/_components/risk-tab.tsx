import {
  AlertTriangle,
  Info,
  ShieldAlert,
  ShieldCheck,
  Sigma,
  Target,
  TriangleAlert,
  Users,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { HubNotice } from "../../../_components/hub-notice";
import { Card } from "@/components/ui/card";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import {
  getRiskData,
  RISK_EDGE_BY_GAME,
  type RiskData,
  type RiskUserRow,
  type RiskGameWager,
} from "../_queries/risk-data";

/**
 * Creator Hub — `creators/[id]` **Risk** tab (wager-saving / perk-abuse
 * detector). Owner spec — see `risk-data.ts` for the full math + the
 * verified prod data-availability findings.
 *
 * House-POV throughout:
 *   • Wager (user risks money → house gain) → emerald.
 *   • Actual house PnL: positive (house up) → emerald, negative → rose.
 *   • The deviation GAP is the abuse signal, NOT a money flow: a large gap
 *     in the user's favour is BAD for the house, so it's rendered in
 *     amber/rose as a risk severity, not as a house gain.
 *
 * LAZY: this component is the ONLY caller of `getRiskData`, so the heavy
 * scan runs solely when the Risk tab is opened (never preloaded). It reads
 * MAIN/prod read-only (cached + timeout-guarded inside the query).
 */
export async function RiskTab({ userId }: { userId: string }) {
  // 60s budget — the cold scan mirrors the creator-PnL scan's cost and warms
  // a 5-min cache; a slow first load completes rather than getting cut off.
  const { data, kind } = await safeQueryOrNull(
    () => getRiskData(userId),
    "creator-hub.creators.risk",
    60_000,
  );

  if (!data) {
    // Truthful band copy — a hard failure must not masquerade as "slow".
    const timedOut = kind === "timeout";
    return (
      <FadeIn className="space-y-5">
        <RiskHeading />
        <HubNotice
          tone="amber"
          icon={Info}
          title={
            timedOut
              ? "Risk scan is taking too long to load"
              : "Risk scan failed to load"
          }
        >
          {timedOut
            ? "The expected-vs-actual P&L scan over this creator's referred users timed out. Refresh to retry — the rest of the page is unaffected."
            : "The expected-vs-actual P&L scan over this creator's referred users failed — its data is unavailable right now. Refresh to retry; the rest of the page is unaffected."}
        </HubNotice>
      </FadeIn>
    );
  }

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <RiskHeading />
      <RiskSummary data={data} />
      <UpgraderSignalBox data={data} />
      <RiskTable data={data} />
      <MethodologyNote data={data} />
    </FadeIn>
  );
}

function RiskHeading() {
  return (
    <SectionHeading
      icon={ShieldAlert}
      title="Risk — wager-saving detector"
    />
  );
}

// ── Cohort summary KPI strip ─────────────────────────────────────────

function RiskSummary({ data }: { data: RiskData }) {
  const {
    cohortUserCount,
    flaggedCount,
    totalExpectedGgrUsd,
    totalActualPnlUsd,
    totalGapUsd,
  } = data;

  // Gap > 0 cohort-wide = users collectively took less loss than the edge
  // predicts → bad for the house → amber/rose severity (NOT a house gain).
  const gapAccent = totalGapUsd > 0 ? "rose" : "emerald";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label="Referred users"
        value={formatNumber(cohortUserCount)}
        sub="With activity (capped 365d)"
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Flagged"
        value={formatNumber(flaggedCount)}
        sub={`Shortfall ≥ ${Math.round(data.threshold * 100)}%`}
        icon={TriangleAlert}
        accent={flaggedCount > 0 ? "rose" : "emerald"}
      />
      <KpiTile
        label="Expected GGR"
        value={formatCurrency(totalExpectedGgrUsd)}
        sub="Wager × blended edge"
        icon={Target}
        accent="emerald"
      />
      <KpiTile
        label="Actual house P&L"
        value={formatCurrency(totalActualPnlUsd)}
        sub="Deposits − card WD"
        icon={Sigma}
        accent={
          totalActualPnlUsd > 0
            ? "emerald"
            : totalActualPnlUsd < 0
              ? "rose"
              : "blue"
        }
      />
      <KpiTile
        label="Deviation gap"
        value={formatCurrency(totalGapUsd)}
        sub="Expected − actual (↑ = risk)"
        icon={AlertTriangle}
        accent={gapAccent}
      />
    </div>
  );
}

// ── Upgrader behavioural signal (data-gap-aware) ─────────────────────

function UpgraderSignalBox({ data }: { data: RiskData }) {
  const sig = data.upgraderSignal;

  if (!sig.available) {
    // Honest data-gap state — never fabricated. On prod today this is the
    // "upgrader not live" case verified read-only.
    return (
      <HubNotice
        tone="muted"
        icon={Info}
        dashed
        title="High-win-chance upgrader signal — not available"
      >
        {sig.unavailableReason}
      </HubNotice>
    );
  }

  const total = sig.totalUpgraderBets ?? 0;
  const high = sig.highWinChanceBets ?? 0;
  const pct = total > 0 ? (high / total) * 100 : 0;
  // A high share of low-variance (high-win-chance) upgrader bets is a
  // wager-saving pattern → bad for the house → rose when material.
  const accent = pct >= 50 ? "rose" : pct >= 20 ? "amber" : "emerald";
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <KpiTile
        label="Upgrader bets"
        value={formatNumber(total)}
        sub="Under this code"
        icon={Target}
        accent="blue"
      />
      <KpiTile
        label="High win-chance"
        value={formatNumber(high)}
        sub="≥ 80% target chance"
        icon={TriangleAlert}
        accent={accent}
      />
      <KpiTile
        label="Low-variance share"
        value={`${pct.toFixed(1)}%`}
        sub="Of upgrader bets"
        icon={AlertTriangle}
        accent={accent}
      />
    </div>
  );
}

// ── Worst-first user table ───────────────────────────────────────────

function RiskTable({ data }: { data: RiskData }) {
  if (data.users.length === 0) {
    return (
      <Card size="sm" className="p-6 text-center text-sm text-muted-foreground">
        No referred-user activity to assess for this creator yet.
      </Card>
    );
  }

  return (
    <Card size="sm" className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[160px]">User</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="min-w-[180px]">Wager (by game)</TableHead>
              <TableHead className="text-right">Expected GGR</TableHead>
              <TableHead className="text-right">Actual P&amp;L</TableHead>
              <TableHead className="text-right">Gap</TableHead>
              <TableHead className="text-right">Risk</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.users.map((u) => (
              <RiskRow key={u.userId} user={u} />
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function RiskRow({ user }: { user: RiskUserRow }) {
  const initials = (user.username ?? user.userId).slice(0, 2).toUpperCase();

  // Actual PnL house-POV color.
  const pnlClass =
    user.actualPnlUsd > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : user.actualPnlUsd < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";

  // Gap > 0 = user took less loss than expected → risk → amber/rose.
  const gapClass =
    user.gapUsd > 0
      ? user.flagged
        ? "text-rose-600 dark:text-rose-400"
        : "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <TableRow className={cn(user.flagged && "bg-rose-500/[0.04]")}>
      {/* User */}
      <TableCell>
        <div className="flex items-center gap-2">
          <Avatar className="size-7 shrink-0">
            {user.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback className="text-[10px] font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {user.username ?? `${user.userId.slice(0, 8)}…`}
            </div>
            {!user.isDepositor && (
              <span
                className="text-[10px] text-amber-600 dark:text-amber-400"
                title="No coverage-attributed deposit under this code — card withdrawals are excluded from this user's P&L (same rule as the creator P&L panel)."
              >
                wager-only
              </span>
            )}
          </div>
        </div>
      </TableCell>

      {/* Deposits (user money in → house gain → emerald) */}
      <TableCell className="text-right tabular-nums">
        {user.depositsUsd > 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            {formatCurrency(user.depositsUsd)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Wager + per-game split */}
      <TableCell>
        <div className="space-y-1">
          <div className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCurrency(user.wagerUsd)}
          </div>
          <GameSplit byGame={user.byGame} />
        </div>
      </TableCell>

      {/* Expected GGR (what the edge predicts the house should win) */}
      <TableCell className="text-right tabular-nums">
        {user.expectedGgrUsd > 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            {formatCurrency(user.expectedGgrUsd)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Actual realised house PnL */}
      <TableCell className={cn("text-right tabular-nums", pnlClass)}>
        {user.actualPnlUsd === 0 && !user.isDepositor
          ? "—"
          : formatCurrency(user.actualPnlUsd)}
      </TableCell>

      {/* Deviation gap */}
      <TableCell className={cn("text-right font-medium tabular-nums", gapClass)}>
        {user.gapUsd > 0 ? "+" : ""}
        {formatCurrency(user.gapUsd)}
      </TableCell>

      {/* Risk badge */}
      <TableCell className="text-right">
        <RiskBadge user={user} />
      </TableCell>
    </TableRow>
  );
}

const GAME_LABEL: Record<RiskGameWager["game"], string> = {
  pack: "Packs",
  battle: "Battles",
  upgrader: "Upgrader",
  unknown: "Other",
};

function GameSplit({ byGame }: { byGame: RiskGameWager[] }) {
  const shown = byGame.filter((g) => g.wagerUsd > 0).slice(0, 3);
  if (shown.length === 0) {
    return <span className="text-[11px] text-muted-foreground">no wager</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((g) => (
        <span
          key={g.game}
          className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={`${GAME_LABEL[g.game]}: ${formatCurrency(g.wagerUsd)} wagered · expected GGR ${formatCurrency(g.expectedGgrUsd)} (edge ${(edgeFor(g.game) * 100).toFixed(1)}%)`}
        >
          <span className="font-medium text-foreground/70">
            {GAME_LABEL[g.game]}
          </span>
          {formatCompactUsd(g.wagerUsd)}
        </span>
      ))}
    </div>
  );
}

function RiskBadge({ user }: { user: RiskUserRow }) {
  if (user.shortfallPct == null) {
    return (
      <Badge
        variant="secondary"
        className="text-[10px]"
        title={`Expected GGR below the minimum needed to assess (thin volume). Wager ${formatCurrency(user.wagerUsd)}.`}
      >
        n/a
      </Badge>
    );
  }
  if (user.flagged) {
    return (
      <Badge
        className="gap-1 border-rose-500/30 bg-rose-500/15 text-[10px] text-rose-600 dark:text-rose-400"
        title={`Wager-saving flag: actual house P&L is ${Math.round((user.shortfallPct ?? 0) * 100)}% below the expected GGR. Risk score ${user.riskScore}/100.`}
      >
        <ShieldAlert className="size-3" />
        {user.riskScore}
      </Badge>
    );
  }
  // Not flagged — show the score muted (or a "clean" check when at/above
  // expectation, i.e. shortfall ≤ 0).
  if (user.shortfallPct <= 0) {
    return (
      <Badge
        variant="outline"
        className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
        title="Actual house P&L is at or above the expected GGR — taking the edge as expected."
      >
        <ShieldCheck className="size-3" />
        ok
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] text-amber-600 dark:text-amber-400"
      title={`Below expectation by ${Math.round(user.shortfallPct * 100)}%, under the ${Math.round(user.shortfallPct >= 0 ? user.shortfallPct * 100 : 0)}% flag threshold. Risk score ${user.riskScore}/100.`}
    >
      {user.riskScore}
    </Badge>
  );
}

// ── Methodology ──────────────────────────────────────────────────────

function MethodologyNote({ data }: { data: RiskData }) {
  return (
    <HubNotice tone="muted" icon={Info} dashed>
      <span>
        <span className="font-medium text-foreground/80">How this works.</span>{" "}
        For each referred user under this creator&apos;s code we compute the{" "}
        <span className="font-medium">expected house GGR</span> = Σ (wager per
        game × that game&apos;s edge: packs{" "}
        {(RISK_EDGE_BY_GAME.pack * 100).toFixed(1)}%, battles{" "}
        {(RISK_EDGE_BY_GAME.battle * 100).toFixed(1)}%, upgrader{" "}
        {(RISK_EDGE_BY_GAME.upgrader * 100).toFixed(0)}%), and compare it to the{" "}
        <span className="font-medium">actual house P&amp;L</span> (coverage-
        attributed deposits − attributed card/voucher withdrawals — the same
        per-user formula as the creator P&amp;L panel). The{" "}
        <span className="font-medium">gap</span> = expected − actual; a large
        positive gap means the user took far less loss than the edge predicts
        (&quot;saving wager&quot; to farm leaderboard / perks without real
        risk). Users are flagged at a{" "}
        {Math.round(data.threshold * 100)}% shortfall and sorted worst-first.
        Only non-borrowed wager counts (borrow-correction is already baked into
        the wager figure). Window: lifetime, capped at {data.lookbackDays} days.
        Read-only over the live game data.
        {data.partial && (
          <>
            {" "}
            <span className="text-amber-600 dark:text-amber-400">
              Some figures are partial — a scan degraded, so totals are a lower
              bound.
            </span>
          </>
        )}
      </span>
    </HubNotice>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function edgeFor(game: RiskGameWager["game"]): number {
  if (game === "pack" || game === "battle" || game === "upgrader") {
    return RISK_EDGE_BY_GAME[game];
  }
  return RISK_EDGE_BY_GAME.pack;
}

/** Compact USD for the per-game chips (e.g. $1.2k, $7.2M). */
function formatCompactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// ── Suspense fallback ────────────────────────────────────────────────


