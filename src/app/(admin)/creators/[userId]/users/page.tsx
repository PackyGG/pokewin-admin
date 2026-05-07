import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Users } from "lucide-react";

import {
  getCreatorDetail,
  getCodeReferrals,
} from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { formatCurrency, formatRelative } from "@/lib/utils/format";

import { CodeActivityNav } from "../_components/code-activity-nav";

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

  const profile = await getCreatorDetail(userId, 1, 1);
  if (!profile) notFound();

  const referrals = profile.code
    ? await getCodeReferrals(profile.code, 200)
    : [];

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
              profile.code ? (
                <Link
                  href={`/creators/codes/${profile.code}`}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  Full code analytics →
                </Link>
              ) : undefined
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
                {referrals.map((r) => (
                  <TableRow key={r.referredUserId}>
                    <TableCell>
                      <Link
                        href={`/users/${r.referredUserId}`}
                        className="font-medium hover:underline"
                      >
                        {r.referredUsername ??
                          r.referredEmail ??
                          r.referredUserId.slice(0, 8)}
                      </Link>
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
                ))}
                {referrals.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {profile.code
                        ? "No users on this code yet."
                        : "Creator has no affiliate code."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
