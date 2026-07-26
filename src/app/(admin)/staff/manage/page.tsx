import Link from "next/link";
import { BadgeCheck, Settings, Trophy } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requireStaffManagerPage } from "@/lib/staff/access";

export const metadata = { title: "Staff Manage" };

export default async function StaffManagePage() {
  await requireStaffManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Settings}
          accent="purple"
          title="Staff Manage"
          subtitle="Point system and quiz administration"
        />
      </PageHero>

      <div className="grid gap-4 sm:grid-cols-2">
        <ManageLink
          href="/staff/points"
          icon={Trophy}
          title="Point system"
          body="Balances, level thresholds and the points ledger"
        />
        <ManageLink
          href="/staff/quiz-manager"
          icon={BadgeCheck}
          title="Quiz manager"
          body="Create, publish and maintain support quizzes"
        />
      </div>
    </div>
  );
}

function ManageLink({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string;
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-border/60 bg-card p-5 transition-colors hover:border-purple-500/40 hover:bg-accent/30"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400">
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </Link>
  );
}
