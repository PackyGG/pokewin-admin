"use client";

/**
 * Trust / Risk tab content for the modern user detail view.
 *
 * Layout (top to bottom):
 *   1. Score hero — big tier-colored number + gauge, tier badge,
 *      sub-metrics (shared IPs, shared fingerprints, signal counts).
 *   2. Signal breakdown — grouped by category, triggered signals
 *      highlighted in rose, non-triggered dimmed.
 *   3. Shared IPs table — other users linked by IP.
 *   4. Shared fingerprints table — other users linked by device.
 *
 * The component is pure presentation. Data is fetched server-side in
 * the page and passed down; the only interactivity is the "Refresh
 * score" button which triggers the refreshRiskScoreAction server action.
 */

import * as React from "react";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ShieldAlert,
  Activity,
  Link2,
  Fingerprint,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Wallet,
  Swords,
  Gift,
  Users as UsersIcon,
  User as UserIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { toast } from "sonner";
import {
  RISK_TIER_COLORS,
  tierLabel,
  type RiskCategory,
  type RiskScoreBreakdown,
  type RiskSignal,
  type RiskTier,
} from "@/lib/fraud/score";
import type { SharedIdentityUser } from "@/lib/fraud/shared-identity";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import { SectionHeading } from "./user-view-modern-panels";
import { refreshRiskScoreAction } from "./trust-actions";

// ---------------------------------------------------------------------------
// TRUST TAB (root)
// ---------------------------------------------------------------------------

export function TrustTab({
  userId,
  breakdown,
  sharedIps,
  sharedFingerprints,
}: {
  userId: string;
  breakdown: RiskScoreBreakdown;
  sharedIps: SharedIdentityUser[];
  sharedFingerprints: SharedIdentityUser[];
}) {
  return (
    <div className="space-y-6">
      <ScoreHero userId={userId} breakdown={breakdown} />

      <SectionHeading icon={Activity} title="Signal breakdown" />
      <SignalBreakdown signals={breakdown.signals} />

      <SectionHeading icon={Link2} title="Shared IPs" />
      <SharedIdentityTable
        users={sharedIps}
        identityLabel="IPs"
        emptyLabel="No other accounts share an IP with this user."
      />

      <SectionHeading icon={Fingerprint} title="Shared device fingerprints" />
      <SharedIdentityTable
        users={sharedFingerprints}
        identityLabel="Fingerprints"
        emptyLabel="No other accounts share a device fingerprint with this user."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SCORE HERO
// ---------------------------------------------------------------------------

function ScoreHero({
  userId,
  breakdown,
}: {
  userId: string;
  breakdown: RiskScoreBreakdown;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { score, tier, signals, sharedIpCount, sharedFingerprintCount } =
    breakdown;

  // Split tier → color token for the central gauge. We map directly
  // rather than reuse RISK_TIER_COLORS because the hero uses larger,
  // solid-ish color tones (500/400 for the ring) rather than the /15
  // badge palette.
  const ringStops = TIER_RING_COLORS[tier];
  const triggered = signals.filter((s) => s.triggered).length;
  const byCategory: Record<RiskCategory, number> = {
    velocity: 0,
    gameplay: 0,
    rewards: 0,
    network: 0,
    account: 0,
  };
  for (const s of signals) {
    if (s.triggered) byCategory[s.category] += s.weight;
  }

  const handleRefresh = (): void => {
    startTransition(async () => {
      try {
        await refreshRiskScoreAction(userId);
        toast.success("Risk score recomputed");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to refresh score",
        );
      }
    });
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-24 -top-24 size-72 rounded-full blur-3xl",
          ringStops.glow,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-blue-500/[0.06] blur-3xl"
      />

      <div className="relative grid gap-6 p-6 md:grid-cols-[auto_1fr]">
        {/* Left — gauge + score number */}
        <div className="flex flex-col items-center gap-3">
          <RiskGauge score={score} tier={tier} />
          <Badge
            variant="outline"
            className={cn("text-xs px-2.5 py-0.5", RISK_TIER_COLORS[tier])}
          >
            {tierLabel(tier)} risk
          </Badge>
        </div>

        {/* Right — copy + sub-metrics */}
        <div className="flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
                  <ShieldAlert className="size-4 text-primary" />
                </div>
                <h3 className="text-lg font-semibold">Trust assessment</h3>
              </div>
              <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
                {headlineFor(tier, triggered)}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isPending}
              className="shrink-0"
            >
              <RefreshCw className={cn("size-3.5 mr-1.5", isPending && "animate-spin")} />
              Refresh
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <SubMetric
              icon={AlertTriangle}
              label="Signals triggered"
              value={`${triggered} / ${signals.length}`}
              accent={triggered > 0 ? "rose" : "emerald"}
            />
            <SubMetric
              icon={Link2}
              label="Shared IPs"
              value={String(sharedIpCount)}
              accent={sharedIpCount >= 2 ? "rose" : "emerald"}
            />
            <SubMetric
              icon={Fingerprint}
              label="Shared fingerprints"
              value={String(sharedFingerprintCount)}
              accent={sharedFingerprintCount >= 1 ? "rose" : "emerald"}
            />
            <SubMetric
              icon={Activity}
              label="Top category"
              value={(() => {
                const entries = Object.entries(byCategory) as [
                  RiskCategory,
                  number,
                ][];
                const top = entries.reduce(
                  (acc, cur) => (cur[1] > acc[1] ? cur : acc),
                  entries[0],
                );
                return top[1] > 0 ? CATEGORY_LABELS[top[0]] : "None";
              })()}
              accent={triggered > 0 ? "amber" : "emerald"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * CSS-only radial gauge. Uses conic-gradient with the tier color,
 * respecting `prefers-reduced-motion` for the fill transition.
 */
function RiskGauge({ score, tier }: { score: number; tier: RiskTier }) {
  const ring = TIER_RING_COLORS[tier];
  const pct = Math.max(0, Math.min(100, score));
  const deg = (pct / 100) * 360;
  // Two-stop conic gradient: colored portion up to `deg`, then the track
  // color. Wrapped in a circular div with an inner white/card disk to
  // carve out the hollow center.
  return (
    <div className="relative inline-flex size-36 items-center justify-center">
      <div
        className="absolute inset-0 rounded-full transition-[background] duration-500 motion-reduce:transition-none"
        style={{
          background: `conic-gradient(${ring.cssRing} 0deg ${deg}deg, var(--muted) ${deg}deg 360deg)`,
        }}
      />
      <div className="relative flex size-28 flex-col items-center justify-center rounded-full bg-card shadow-sm">
        <span
          className={cn(
            "text-4xl font-bold tabular-nums leading-none",
            ring.text,
          )}
        >
          {score}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          risk / 100
        </span>
      </div>
    </div>
  );
}

function SubMetric({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  accent: "emerald" | "rose" | "amber";
}) {
  const ring =
    accent === "rose"
      ? "text-rose-500"
      : accent === "amber"
        ? "text-amber-500"
        : "text-emerald-500";
  const bg =
    accent === "rose"
      ? "bg-rose-500/10 border-rose-500/20"
      : accent === "amber"
        ? "bg-amber-500/10 border-amber-500/20"
        : "bg-emerald-500/10 border-emerald-500/20";
  return (
    <div className={cn("rounded-xl border px-3 py-2", bg)}>
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5", ring)} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-0.5 text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SIGNAL BREAKDOWN — grouped by category
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: RiskCategory[] = [
  "velocity",
  "gameplay",
  "rewards",
  "network",
  "account",
];

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  velocity: "Money velocity",
  gameplay: "Gameplay",
  rewards: "Rewards & bonuses",
  network: "Network & identity",
  account: "Account state",
};

const CATEGORY_ICONS: Record<RiskCategory, React.ElementType> = {
  velocity: Wallet,
  gameplay: Swords,
  rewards: Gift,
  network: Link2,
  account: ShieldAlert,
};

function SignalBreakdown({ signals }: { signals: RiskSignal[] }) {
  const grouped = useMemoGrouped(signals);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {CATEGORY_ORDER.map((cat) => {
        const Icon = CATEGORY_ICONS[cat];
        const catSignals = grouped[cat] ?? [];
        const triggered = catSignals.filter((s) => s.triggered).length;
        const contribution = catSignals.reduce(
          (acc, s) => (s.triggered ? acc + s.weight : acc),
          0,
        );
        return (
          <Card
            key={cat}
            className={cn(
              "overflow-hidden",
              triggered > 0 ? "border-rose-500/30" : "",
            )}
          >
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md",
                      triggered > 0
                        ? "bg-rose-500/10 text-rose-500"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </div>
                  <span className="text-sm font-semibold">
                    {CATEGORY_LABELS[cat]}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">
                    {triggered}/{catSignals.length}
                  </span>
                  {contribution > 0 && (
                    <Badge
                      variant="outline"
                      className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 tabular-nums h-5 px-1.5"
                    >
                      +{contribution}
                    </Badge>
                  )}
                </div>
              </div>
              <ul className="space-y-1.5 border-t pt-2">
                {catSignals.map((s) => (
                  <SignalRow key={s.id} signal={s} />
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function useMemoGrouped(
  signals: RiskSignal[],
): Partial<Record<RiskCategory, RiskSignal[]>> {
  return React.useMemo(() => {
    const out: Partial<Record<RiskCategory, RiskSignal[]>> = {};
    for (const s of signals) {
      const list = out[s.category] ?? [];
      list.push(s);
      out[s.category] = list;
    }
    return out;
  }, [signals]);
}

function SignalRow({ signal }: { signal: RiskSignal }) {
  const Icon = signal.triggered ? AlertTriangle : CheckCircle2;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
        signal.triggered
          ? "bg-rose-500/5"
          : "opacity-60 hover:opacity-100",
      )}
    >
      <Icon
        className={cn(
          "size-3.5 mt-0.5 shrink-0",
          signal.triggered ? "text-rose-500" : "text-emerald-500",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "font-medium",
              signal.triggered ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {signal.label}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {signal.value !== undefined && (
              <span className="font-mono tabular-nums text-muted-foreground text-[11px]">
                {String(signal.value)}
              </span>
            )}
            {signal.triggered && signal.weight > 0 && (
              <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                +{signal.weight}
              </span>
            )}
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
          {signal.explanation}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// SHARED IDENTITY TABLE
// ---------------------------------------------------------------------------

function SharedIdentityTable({
  users,
  identityLabel,
  emptyLabel,
}: {
  users: SharedIdentityUser[];
  identityLabel: string;
  emptyLabel: string;
}) {
  if (users.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          <UserIcon className="mx-auto mb-2 size-5 opacity-50" />
          {emptyLabel}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-hidden rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">User</th>
                <th className="px-4 py-2 text-left font-semibold">Role</th>
                <th className="px-4 py-2 text-left font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">
                  Shared {identityLabel}
                </th>
                <th className="px-4 py-2 text-right font-semibold">Events</th>
                <th className="px-4 py-2 text-left font-semibold">
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const statusKey = u.isBanned
                  ? "banned"
                  : u.isLocked
                    ? "locked"
                    : "active";
                const statusLabel = u.isBanned
                  ? "Banned"
                  : u.isLocked
                    ? "Locked"
                    : "Active";
                return (
                  <tr
                    key={u.userId}
                    className="border-t hover:bg-accent/40"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/users/${u.userId}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Avatar className="size-7">
                          {u.image && (
                            <AvatarImage src={u.image} alt="" />
                          )}
                          <AvatarFallback className="text-[10px]">
                            {(u.username ?? u.email ?? "?")
                              .slice(0, 2)
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {u.username ?? u.email ?? u.userId.slice(0, 8)}
                          </div>
                          {u.email && u.username && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {u.email}
                            </div>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", ROLE_COLORS[u.role] ?? "")}
                      >
                        {u.role}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          USER_STATUS_COLORS[statusKey] ?? "",
                        )}
                      >
                        {statusLabel}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">
                      {u.sharedCount}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {u.totalEvents}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {u.lastSeenAt ? formatRelative(u.lastSeenAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {users.length === 50 && (
          <p className="px-4 py-2 text-[11px] text-muted-foreground border-t">
            Showing the first 50 matches, sorted by shared {identityLabel.toLowerCase()} count.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIER_RING_COLORS: Record<
  RiskTier,
  {
    text: string;
    /** Conic-gradient color value (RGB or hex). Must be a color, not a class. */
    cssRing: string;
    /** Tailwind class for the hero glow behind the gauge. */
    glow: string;
  }
> = {
  low: {
    text: "text-emerald-600 dark:text-emerald-400",
    cssRing: "rgb(16 185 129)", // emerald-500
    glow: "bg-emerald-500/[0.08]",
  },
  medium: {
    text: "text-amber-600 dark:text-amber-400",
    cssRing: "rgb(245 158 11)", // amber-500
    glow: "bg-amber-500/[0.08]",
  },
  high: {
    text: "text-orange-600 dark:text-orange-400",
    cssRing: "rgb(249 115 22)", // orange-500
    glow: "bg-orange-500/[0.08]",
  },
  critical: {
    text: "text-rose-600 dark:text-rose-400",
    cssRing: "rgb(244 63 94)", // rose-500
    glow: "bg-rose-500/[0.08]",
  },
};

function headlineFor(tier: RiskTier, triggered: number): string {
  if (tier === "critical") {
    return `Critical risk: ${triggered} signal${triggered === 1 ? "" : "s"} firing at once. Immediate review recommended.`;
  }
  if (tier === "high") {
    return `High risk: ${triggered} signal${triggered === 1 ? "" : "s"} triggered. Worth a manual look.`;
  }
  if (tier === "medium") {
    return `Medium risk: ${triggered} signal${triggered === 1 ? "" : "s"} triggered. Keep an eye on this account.`;
  }
  return triggered > 0
    ? `Low overall risk, though ${triggered} minor signal${triggered === 1 ? "" : "s"} ${triggered === 1 ? "has" : "have"} fired. Nothing that needs attention right now.`
    : "Low risk across all signal categories. Clean account profile.";
}

// Unused imports in the component surface get auto-removed by tsc; keeping
// UsersIcon defensively-imported for a future "N users linked" rollup.
void UsersIcon;
