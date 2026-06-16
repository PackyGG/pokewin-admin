import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Shuffle, Users } from "lucide-react";

import {
  getCreatorHeader,
  getCodeReferrals,
} from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHero, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatRelative } from "@/lib/utils/format";

import { CodeActivityNav } from "../_components/code-activity-nav";
import { CodeHopperBadge } from "../_components/code-hopper-badge";
import {
  getCodeHopperFlags,
  type CodeHopperInfo,
} from "../_queries/code-hopper-flags";

export const metadata = { title: "Users on Code · Creator" };

// Dedicated full-width page for the "Users on this code" view. Lifted
// out of the inline tab on /creators/[userId] per user direction so each
// sub-view feels like its own page rather than a small inline panel.
//
// Pulls a richer page-size (200) than the main-page preview ever did
// (25), since this is the dedicated drill-in view. Same staff exclusion
// (admin/support) applied at the query level.
export default async function CreatorUsersPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requirePageAccess("/creators");
  const { userId } = await params;

  // Only the cheap header (2 indexed lookups) is awaited on the critical
  // path so the hero + nav paint immediately; the heavy code-referral scan
  // (+ code-hopper fan-out) streams in its own Suspense boundary below
  // (mirrors the streaming pattern on /creators/[userId]). Identical data +
  // render — just deferred.
  const profile = await getCreatorHeader(userId);
  if (!profile) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-start gap-3 flex-wrap">
          <Link
            href={`/creators/${userId}`}
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
            aria-label="Back to creator detail"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <Avatar className="size-10 sm:size-11 shrink-0">
            {profile.image && <AvatarImage src={profile.image} alt="" />}
            <AvatarFallback className="text-xs font-semibold">
              {(profile.username ?? profile.email ?? "?").slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                href={`/creators/${userId}`}
                className="text-xl sm:text-2xl font-bold leading-tight hover:underline truncate"
              >
                {profile.username ?? profile.email}
              </Link>
              {profile.code ? (
                <Badge variant="outline" className="font-mono text-[11px]">
                  {profile.code}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[11px]">
                  No affiliate code
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Users who signed up, deposited, or wagered on this creator&apos;s code.
            </p>
          </div>
        </div>
      </PageHero>

      {/* Pill-tab nav so the admin can flip between the two
          code-activity views without going back to the creator page. */}
      <CodeActivityNav userId={userId} active="users" />

      <Suspense fallback={<UsersSectionSkeleton />}>
        <UsersSection userId={userId} code={profile.code} />
      </Suspense>
    </div>
  );
}

// ── Streamed code-referral list ───────────────────────────────────────
//
// Owns the heavy `getCodeReferrals` scan (up to 200 rows) + the
// code-hopper fan-out. Streamed behind its own Suspense boundary so the
// hero + code-activity nav paint off the cheap header instead of waiting
// on the list. Same queries, same args, same render output — only deferred.
async function UsersSection({
  userId,
  code,
}: {
  userId: string;
  code: string | null;
}) {
  // getCodeReferrals returns a discriminated result so a failed /
  // timed-out lookup is distinguishable from a genuinely empty code.
  // referralsResult is null only when the creator has no code at all.
  const referralsResult = code ? await getCodeReferrals(code, 200) : null;
  const loadFailed = referralsResult !== null && !referralsResult.ok;
  const referrals =
    referralsResult && referralsResult.ok ? referralsResult.referrals : [];

  // Code-hopper flags — which of these referred users have used 2+
  // distinct affiliate codes (the code-switching / leaderboard-sniping
  // signal reused from the streamers abuse-detection surface). One
  // batched grouped query over the resolved user-id set; best-effort, so
  // a failure just renders the list without badges. Skipped entirely
  // when there are no users to flag.
  const codeHopperFlags: Map<string, CodeHopperInfo> =
    referrals.length > 0
      ? await getCodeHopperFlags(referrals.map((r) => r.referredUserId))
      : new Map();
  const codeHopperCount = codeHopperFlags.size;

  return (
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Users}
            title={
              referrals.length > 0
                ? `${referrals.length} user${referrals.length === 1 ? "" : "s"} on this code`
                : "Users on this code"
            }
            action={
              <div className="flex items-center gap-3">
                {/* Code-hopper summary — how many of the listed users
                    used 2+ distinct codes. Amber caution chip so an admin
                    can gauge at a glance whether this code's numbers are
                    inflated by code-switchers before scanning the rows. */}
                {codeHopperCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
                    title={`${codeHopperCount} of ${referrals.length} listed users have used 2+ distinct affiliate codes (possible code-hoppers).`}
                  >
                    <Shuffle className="size-3" aria-hidden />
                    {codeHopperCount} code-hopper
                    {codeHopperCount === 1 ? "" : "s"}
                  </span>
                )}
                {code ? (
                  <Link
                    href={`/creators/${userId}`}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Creator profile →
                  </Link>
                ) : null}
              </div>
            }
          />
          <div className="rounded-2xl border bg-card/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  {/* Wager volume — money INTO house treasury per
                      CLAUDE.md house-POV → emerald in the body. */}
                  <TableHead className="text-right">Wagered</TableHead>
                  {/* Commission paid TO creator → house outflow → rose. */}
                  <TableHead className="text-right">Commission</TableHead>
                  <TableHead>Last activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.map((r) => {
                  const hopper = codeHopperFlags.get(r.referredUserId);
                  return (
                  <TableRow key={r.referredUserId}>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/users/${r.referredUserId}`}
                          className="font-medium hover:underline"
                        >
                          {r.referredUsername ??
                            r.referredEmail ??
                            r.referredUserId.slice(0, 8)}
                        </Link>
                        {/* Code-hopper flag — used 2+ distinct codes.
                            Inline so the admin sees inflated-by-switcher
                            users right in the row. */}
                        {hopper && (
                          <CodeHopperBadge codeCount={hopper.distinctCodeCount} />
                        )}
                      </div>
                      {r.referredEmail && r.referredUsername && (
                        <p className="text-xs text-muted-foreground truncate">
                          {r.referredEmail}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(r.totalWagersUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(r.totalCommissionUsd)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRelative(r.lastActivityAt)}
                    </TableCell>
                  </TableRow>
                  );
                })}
                {loadFailed && (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center">
                      <div className="flex flex-col items-center gap-1 text-sm">
                        <span className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-4" />
                          Couldn&apos;t load users for this code
                        </span>
                        <span className="text-xs text-muted-foreground">
                          The lookup timed out — refresh the page to try again.
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {!loadFailed && referrals.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState
                        icon={Users}
                        title={
                          code
                            ? "No users on this code yet"
                            : "Creator has no affiliate code"
                        }
                        description={
                          code
                            ? "Users who sign up, deposit, or wager on this code will appear here."
                            : "Once this creator owns an affiliate code, their referred users show up here."
                        }
                        compact
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </FadeIn>
  );
}

// Inner Suspense fallback — section heading (with trailing action) + the
// 4-column code-referral table shape, matching the route-level loading
// skeleton so nothing reflows when the real list streams in.
function UsersSectionSkeleton() {
  return (
    <div className="space-y-3">
      <SectionHeadingSkeleton titleWidth={180} action />
      <div className="overflow-hidden rounded-2xl border bg-card/60">
        <div className="flex items-center gap-4 border-b px-4 py-3">
          <Skeleton className="h-4 w-16 rounded" />
          <Skeleton className="ml-auto h-4 w-20 rounded" />
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-4 w-24 rounded" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 10 }).map((_, r) => (
            <div key={r} className="flex items-center gap-4 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="h-4 w-28 rounded" />
              </div>
              <Skeleton className="ml-auto h-4 w-16 rounded" />
              <Skeleton className="h-4 w-20 rounded" />
              <Skeleton className="h-4 w-24 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
