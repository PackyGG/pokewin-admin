import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Coins,
  Package,
  Swords,
  Trophy,
} from "lucide-react";

import {
  getCreatorHeader,
  getRecentWagersOnCode,
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
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";

import { CodeActivityNav } from "../_components/code-activity-nav";

export const metadata = { title: "Last Wagers · Creator" };

const WAGER_TYPE_META: Record<
  "pack_opening" | "battle_bet" | "battle_sponsorship",
  { label: string; icon: React.ElementType; className: string }
> = {
  pack_opening: {
    label: "Pack",
    icon: Package,
    className:
      "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  battle_bet: {
    label: "Battle bet",
    icon: Swords,
    className:
      "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  },
  battle_sponsorship: {
    label: "Battle sponsor",
    icon: Trophy,
    className:
      "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
};

// Dedicated full-width page for the "Last wagers" feed. Same shape +
// same staff exclusion as the users page sibling — pulls a richer
// page-size (100) than the inline preview ever did (25).
export default async function CreatorWagersPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await requirePageAccess("/creators");
  const { userId } = await params;

  const profile = await getCreatorHeader(userId);
  if (!profile) notFound();

  const wagers = profile.code
    ? await getRecentWagersOnCode(profile.code, 100)
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
              Recent wager events from users tied to this creator&apos;s code.
            </p>
          </div>
        </div>
      </PageHero>

      <CodeActivityNav userId={userId} active="wagers" />

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Activity}
            title={
              wagers.length > 0
                ? `${wagers.length} recent wager${wagers.length === 1 ? "" : "s"}`
                : "Last wagers"
            }
          />
          <div className="rounded-2xl border bg-card/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wagers.map((w) => {
                  const meta = WAGER_TYPE_META[w.type];
                  const Icon = meta?.icon ?? Coins;
                  return (
                    <TableRow key={w.id}>
                      <TableCell>
                        <Link
                          href={`/users/${w.userId}`}
                          className="font-medium hover:underline"
                        >
                          {w.username ?? w.email ?? w.userId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={meta?.className ?? "text-xs"}
                        >
                          <Icon className="mr-1 size-3" />
                          {meta?.label ?? w.type}
                        </Badge>
                      </TableCell>
                      {/* Wager amount — money INTO the house treasury.
                          emerald per CLAUDE.md house-POV (user wagers =
                          good for us). Display as positive (the raw
                          ledger amount is negative because it's a debit
                          on the user's side). */}
                      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(w.amountUsd)}
                      </TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground"
                        title={formatDateTime(w.createdAt)}
                      >
                        {formatRelative(w.createdAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {wagers.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="h-24 text-center text-muted-foreground"
                    >
                      {profile.code
                        ? "No wager activity yet."
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
