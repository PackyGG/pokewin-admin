"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Clock3,
  Database,
  MessageCircle,
  RefreshCw,
  Trophy,
  Users,
} from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  CommunityXpDashboard,
  CommunityXpReason,
  CommunityXpSource,
} from "@/lib/discord-community-xp";

const number = new Intl.NumberFormat("en-US");

const REASON_LABELS: Record<CommunityXpReason, string> = {
  awarded: "Awarded",
  cooldown: "Cooldown",
  duplicate: "Duplicate",
  low_quality: "Low quality",
  too_short: "Too short",
  daily_cap: "Daily cap",
};

function sourceLabel(source: CommunityXpSource): string {
  return source === "discord" ? "Discord" : "Site chat";
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border bg-muted/15 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function DiscordCommunityXpDashboard({ data }: { data: CommunityXpDashboard }) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const awardRate = data.last24Hours.processed
    ? Math.round((data.last24Hours.awarded / data.last24Hours.processed) * 100)
    : 0;
  const maxRankMembers = Math.max(1, ...data.rankDistribution.map((rank) => rank.members));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Activity className="size-5 text-primary" />
                <CardTitle>XP operations</CardTitle>
              </div>
              <CardDescription className="mt-1">
                Live community totals and the last 24 hours of XP decisions across Discord and Packy chat.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                Updated <RelativeTime date={data.generatedAt} />
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isRefreshing}
                onClick={() => startTransition(() => router.refresh())}
              >
                <RefreshCw className={isRefreshing ? "animate-spin" : undefined} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Metric
              icon={Users}
              label="Members"
              value={number.format(data.totals.profiles)}
              detail="Profiles with XP history"
            />
            <Metric
              icon={Trophy}
              label="Total XP"
              value={number.format(data.totals.totalXp)}
              detail={`${number.format(data.totals.countedMessages)} qualifying messages`}
            />
            <Metric
              icon={MessageCircle}
              label="Discord XP"
              value={number.format(data.totals.discordXp)}
              detail="Awarded from server chat"
            />
            <Metric
              icon={Database}
              label="Site-chat XP"
              value={number.format(data.totals.siteChatXp)}
              detail="Awarded through linked accounts"
            />
            <Metric
              icon={Clock3}
              label="24h award rate"
              value={`${awardRate}%`}
              detail={`${number.format(data.last24Hours.awarded)} of ${number.format(data.last24Hours.processed)} processed`}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">24-hour pipeline</p>
                  <p className="text-xs text-muted-foreground">
                    {number.format(data.last24Hours.awardedXp)} XP awarded · {number.format(data.last24Hours.rejected)} filtered
                  </p>
                </div>
                {data.siteChatCursor ? (
                  <div className="text-right text-xs text-muted-foreground">
                    <p>Last site message processed</p>
                    <RelativeTime date={data.siteChatCursor.lastOccurredAt} />
                  </div>
                ) : (
                  <Badge variant="outline">Site cursor not created</Badge>
                )}
              </div>

              <div className="mt-5 space-y-4">
                {data.sources.map((source) => {
                  const accepted = source.processed ? (source.awarded / source.processed) * 100 : 0;
                  return (
                    <div key={source.source}>
                      <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                        <span className="font-medium">{sourceLabel(source.source)}</span>
                        <span className="text-muted-foreground">
                          {number.format(source.awarded)} awarded / {number.format(source.processed)} processed
                        </span>
                      </div>
                      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                        <span className="bg-primary" style={{ width: `${accepted}%` }} />
                        <span className="bg-amber-500/70" style={{ width: `${100 - accepted}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {data.reasons.filter((reason) => reason.count > 0).map((reason) => (
                  <Badge key={reason.reason} variant={reason.reason === "awarded" ? "default" : "outline"}>
                    {REASON_LABELS[reason.reason]} · {number.format(reason.count)}
                  </Badge>
                ))}
                {data.last24Hours.processed === 0 && (
                  <span className="text-sm text-muted-foreground">No XP events were processed in this window.</span>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <p className="font-medium">Rank distribution</p>
              <p className="text-xs text-muted-foreground">Current highest rank across every XP profile.</p>
              <div className="mt-4 space-y-2.5">
                {data.rankDistribution.map((rank) => (
                  <div key={rank.level} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: rank.color }} />
                      <span className="truncate">{rank.name}</span>
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(rank.members / maxRankMembers) * 100}%`,
                          backgroundColor: rank.color,
                        }}
                      />
                    </span>
                    <span className="text-right tabular-nums text-muted-foreground">{rank.members}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 2xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top members</CardTitle>
            <CardDescription>Current all-time leaderboard with source attribution.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table zebra>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Discord member</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead className="text-right">XP</TableHead>
                  <TableHead className="text-right">Sources</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topProfiles.map((profile) => (
                  <TableRow key={profile.discordUserId}>
                    <TableCell className="font-medium tabular-nums">{profile.rank}</TableCell>
                    <TableCell>
                      <a
                        className="font-mono text-xs text-primary hover:underline"
                        href={`https://discord.com/users/${profile.discordUserId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {profile.discordUserId}
                      </a>
                    </TableCell>
                    <TableCell>{profile.level}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {number.format(profile.totalXp)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      D {number.format(profile.discordXp)} · S {number.format(profile.siteChatXp)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.topProfiles.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No community XP profiles yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent XP decisions</CardTitle>
            <CardDescription>Latest awards and filters. Message content is never displayed.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table zebra>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Member</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">XP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      <RelativeTime date={event.occurredAt} />
                    </TableCell>
                    <TableCell>
                      <a
                        className="font-mono text-xs text-primary hover:underline"
                        href={`https://discord.com/users/${event.discordUserId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {event.discordUserId}
                      </a>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{sourceLabel(event.source)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={event.reason === "awarded" ? "default" : "secondary"}>
                        {REASON_LABELS[event.reason]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {event.awardedXp > 0 ? `+${event.awardedXp}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {data.recentEvents.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No XP decisions recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
