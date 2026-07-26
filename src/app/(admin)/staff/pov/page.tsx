import { Suspense } from "react";
import Link from "next/link";
import { Eye, UserCircle } from "lucide-react";

import { requireStaffManagerPage } from "@/lib/staff/access";
import { safeQuery } from "@/lib/errors/safe-query";
import { listStaffMembers } from "@/lib/staff/profile";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { StaffLevelBadge } from "../_components/badges";

export const metadata = { title: "Support POV" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function SupportPovPage() {
  await requireStaffManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Eye}
          accent="purple"
          title="Support POV"
          subtitle="Choose a support agent to preview their Staff Hub"
          backHref="/staff"
        />
      </PageHero>

      <Suspense fallback={<SupportPovListSkeleton />}>
        <SupportPovList />
      </Suspense>
    </div>
  );
}

async function SupportPovList() {
  const { data: members } = await safeQuery(
    () => listStaffMembers(),
    [],
    "staff.pov-members",
    QUERY_TIMEOUT_MS,
  );

  if (members.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
        No support agents have opened Staff Hub yet.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {members.map((member) => {
        const label =
          member.profile.displayName ??
          member.identity?.label ??
          member.profile.adminUserId.slice(0, 8);
        return (
          <Link
            key={member.profile.adminUserId}
            href={`/staff/pov/${member.profile.adminUserId}`}
            className="group flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-purple-500/40 hover:bg-accent/30"
          >
            <Avatar className="shrink-0">
              {member.identity?.hasAvatar && (
                <AvatarImage
                  src={`/api/admin/avatar/${member.profile.adminUserId}`}
                  alt={label}
                />
              )}
              <AvatarFallback>
                {label.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {label}
              </span>
              <span className="mt-1 flex items-center gap-2">
                <StaffLevelBadge level={member.profile.level} />
                <span className="text-xs text-muted-foreground">
                  {member.profile.pointsTotal} points
                </span>
              </span>
            </span>
            <UserCircle className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-purple-500" />
          </Link>
        );
      })}
    </div>
  );
}

function SupportPovListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-20 rounded-xl" />
      ))}
    </div>
  );
}
