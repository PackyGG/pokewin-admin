import { Suspense } from "react";
import { after } from "next/server";
import {
  User,
  Users,
  Wallet,
  HandCoins,
  Coins,
  Gift,
  MousePointerClick,
  Calendar,
  CircleDollarSign,
  Webhook,
  Receipt,
  FileText,
} from "lucide-react";
import { verifySession, sessionHasRole } from "@/lib/dal";
import { getMyProfileData } from "@/lib/queries/my-profile";
import { refreshStaleSocials } from "@/lib/queries/creators";
import { safeQueryOrNull, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { PageHero, KpiTile, SectionHeading } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TabBarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { SocialsCard } from "./socials-card";
import { CreatorWebhooksCard } from "./webhooks-card";
import { DealsTable } from "./deal-detail-dialog";

export const metadata = { title: "My Profile" };

export default async function MyProfilePage() {
  // NO in-render redirect() on this page — an unconditional redirect during
  // the initial document load is replayed by the App Router and crashes it
  // ("Rendered more hooks than during the previous render", see the
  // retired-route block in next.config.ts). `requireRole(["creator"])`
  // fired exactly that for every signed-in non-creator (e.g. a plain
  // admin), and `redirect("/login")` bounced an AUTHED admin to the login
  // page. Instead, non-creators (and creators without profile data) get an
  // informative empty state. Non-creators trigger no data calls at all;
  // creators still only ever read their own data via session.userId.
  const session = await verifySession();
  const isCreator = sessionHasRole(session, "creator");

  // Shell-first: the hero paints immediately; the heavy cross-DB read
  // (adminDb.admin_users + main-DB user/affiliate/account fan-out inside
  // getMyProfileData) streams behind a <Suspense> boundary so it never
  // blocks first paint. Non-creators short-circuit to the empty state with
  // no data call at all.
  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-500/10">
            <User className="size-5 text-cyan-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">My Profile</h1>
            <p className="text-sm text-muted-foreground">
              Creator affiliate profile
            </p>
          </div>
        </div>
      </PageHero>

      {isCreator ? (
        <Suspense
          fallback={
            <>
              <KpiStripSkeleton count={4} />
              <KpiStripSkeleton count={4} />
              <Skeleton className="h-48 rounded-2xl" />
              <div className="space-y-3">
                <TabBarSkeleton count={4} />
                <SectionHeadingSkeleton titleWidth={120} />
                <TableSkeleton rows={6} columns={5} />
              </div>
            </>
          }
        >
          <MyProfileContent userId={session.userId} />
        </Suspense>
      ) : (
        <EmptyState
          icon={User}
          title="No creator profile"
          description="My Profile shows affiliate stats, payouts and deals for creator accounts. This account doesn't have a creator role — creators are managed under /creators."
        />
      )}
    </div>
  );
}

async function MyProfileContent({ userId }: { userId: string }) {
  // safeQuery-wrapped + timeout: any leg of the cross-DB read throwing (or a
  // pathological hang) degrades this section to a band instead of tripping
  // the route error boundary AND blocking the whole page. `data === null`
  // here means EITHER a hard failure (error set) OR a legitimate "no linked
  // creator profile" (getMyProfileData returns null when the admin user has
  // no matching main-site creator) — the two are disambiguated by `error`.
  const { data, error } = await safeQueryOrNull(
    () => getMyProfileData(userId),
    "my-profile.data",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    // Neutral/info degrade — this is an admin self-view, not a money POV
    // number, so rose (house-loss) semantics don't apply. A load failure is
    // an operational error → amber, matching TileErrorFallback conventions.
    return (
      <EmptyState
        icon={User}
        accent="amber"
        title="Couldn’t load your profile"
        description="Your affiliate stats, payouts and deals failed to load or timed out. Refresh to retry — no data was changed."
      />
    );
  }

  if (!data) {
    // No linked creator profile — genuine empty state, not an error.
    return (
      <EmptyState
        icon={User}
        title="No creator profile"
        description="My Profile shows affiliate stats, payouts and deals for creator accounts. This account isn't linked to a main-site creator yet — creators are managed under /creators."
      />
    );
  }

  // Refresh stale social stats once the response has streamed — after()
  // keeps the work off the render path (non-blocking, same as the previous
  // floating promise) but the runtime now keeps the function alive until
  // the callback settles instead of racing a detached promise against
  // function freeze. Failures are logged (never secrets) instead of
  // silently swallowed. Same pattern as the webhook dispatch in
  // src/app/(admin)/creators/actions.ts.
  after(() => {
    refreshStaleSocials(data.userId).catch((err) => {
      console.error("[my-profile] refreshStaleSocials failed:", err);
    });
  });

  return (
    <>
      {/* Identity detail block — streamed under the instant shell hero. Not a
          second PageHero (avoids two stacked gradient heroes); a plain
          bordered card matching the house style, carrying the creator's
          resolved name/code/level and the not-linked warning. */}
      <div className="rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-cyan-500/10">
            <User className="size-5 text-cyan-500" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold leading-tight">
                {data.username ?? data.email}
              </h2>
              {data.code && (
                <Badge variant="outline" className="font-mono">
                  {data.code}
                </Badge>
              )}
              <Badge
                variant="outline"
                className={AFFILIATE_LEVEL_COLORS[data.level] ?? ""}
              >
                {AFFILIATE_LEVEL_LABELS[data.level] ?? `Level ${data.level}`}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{data.email}</p>
            {!data.linked && (
              <p className="mt-2 text-sm text-amber-500">
                Account not linked to the main site yet. Affiliate stats will
                appear once linked by an admin.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* House-POV financial colors:
          - Wager Volume: money flowing FROM users TO us → emerald (house wins)
          - Total Earned / Available / Paid Out / Bonus Distributed: money
            paid TO creator → rose (house loss)
          - Total Referred / Total Clicks: neutral funnel events → blue */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <KpiTile
          label="Total Referred"
          value={formatNumber(data.totalReferred)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Wager Volume"
          value={formatCurrency(data.totalWagerVolumeUsd)}
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Total Earned"
          value={formatCurrency(data.totalEarnedUsd)}
          icon={HandCoins}
          accent="rose"
        />
        <KpiTile
          label="Available"
          value={formatCurrency(data.availableUsd)}
          icon={CircleDollarSign}
          accent="rose"
        />
        <KpiTile
          label="Paid Out"
          value={formatCurrency(data.totalPaidOutUsd)}
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="Bonus Distributed"
          value={formatCurrency(data.totalBonusDistributedUsd)}
          icon={Gift}
          accent="rose"
        />
        <KpiTile
          label="Total Clicks"
          value={formatNumber(data.totalClicks)}
          icon={MousePointerClick}
          accent="cyan"
        />
        <KpiTile
          label="Last Payout"
          value={data.lastPayoutAt ? formatDateTime(data.lastPayoutAt) : "Never"}
          icon={Calendar}
          accent="purple"
        />
      </div>

      <FadeIn>
        <SocialsCard socials={data.socials} />
      </FadeIn>

      <FadeIn>
        <Tabs defaultValue="webhooks">
          <TabsList>
            <TabsTrigger value="webhooks">Webhooks ({data.webhooks.length})</TabsTrigger>
            <TabsTrigger value="referrals">Referrals ({data.referrals.length})</TabsTrigger>
            <TabsTrigger value="payouts">Payouts ({data.payouts.length})</TabsTrigger>
            <TabsTrigger value="deals">Deals ({data.deals.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="webhooks">
            <div className="space-y-3 mt-4">
              <SectionHeading icon={Webhook} title="Webhooks" />
              <CreatorWebhooksCard webhooks={data.webhooks} />
            </div>
          </TabsContent>

          <TabsContent value="referrals">
            <div className="space-y-3 mt-4">
              <SectionHeading icon={Users} title="Referrals" />
              <Card>
                <CardContent className="pt-6">
                  <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Deposit</TableHead>
                        <TableHead>Wager</TableHead>
                        <TableHead>Your Cut</TableHead>
                        <TableHead>User Bonus</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.referrals.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.referredUsername ?? r.referredUserId.slice(0, 8)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{r.usageType}</Badge>
                          </TableCell>
                          {/* Deposit / Wager: money FROM user TO us → emerald. */}
                          <TableCell className="text-emerald-600 dark:text-emerald-400 tabular-nums">
                            {formatCurrency(r.depositAmountUsd)}
                          </TableCell>
                          <TableCell className="text-emerald-600 dark:text-emerald-400 tabular-nums">
                            {formatCurrency(r.wagerAmountUsd)}
                          </TableCell>
                          {/* Creator's own cut is still HOUSE-POV throughout
                              the admin panel (CLAUDE.md: "STRIKT, keine
                              Ausnahmen") — every dollar the creator earned
                              is a dollar we paid out, so rose. */}
                          <TableCell className="text-rose-600 dark:text-rose-400 tabular-nums">
                            {formatCurrency(r.referrerCutUsd)}
                          </TableCell>
                          {/* User bonus: house paid the user a bonus → rose. */}
                          <TableCell className="text-rose-600 dark:text-rose-400 tabular-nums">
                            {formatCurrency(r.userBonusUsd)}
                          </TableCell>
                          <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                      {data.referrals.length === 0 && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={7} className="p-0">
                            <EmptyState
                              icon={Users}
                              title="No referrals yet"
                              description="Users who sign up with your code appear here."
                              compact
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="payouts">
            <div className="space-y-3 mt-4">
              <SectionHeading icon={Receipt} title="Payouts" />
              <Card>
                <CardContent className="pt-6">
                  <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.payouts.map((p) => (
                        <TableRow key={p.id}>
                          {/* Affiliate payout amount → house paid the
                              creator → house loss → rose. */}
                          <TableCell className="text-rose-600 dark:text-rose-400 tabular-nums">
                            {formatCurrency(p.amountUsd)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={
                              p.status === "paid" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" :
                              p.status === "failed" ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30" :
                              "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                            }>
                              {p.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatDateTime(p.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                      {data.payouts.length === 0 && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={3} className="p-0">
                            <EmptyState
                              icon={Receipt}
                              title="No payouts yet"
                              description="Affiliate payouts you receive appear here."
                              compact
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="deals">
            <div className="space-y-3 mt-4">
              <SectionHeading icon={FileText} title="Deals" />
              <DealsTable deals={data.deals} />
            </div>
          </TabsContent>
        </Tabs>
      </FadeIn>
    </>
  );
}
