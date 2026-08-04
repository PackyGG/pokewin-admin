import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  AtSign,
  BadgeCheck,
  Bot,
  ChevronLeft,
  ChevronRight,
  Crown,
  ExternalLink,
  Hash,
  History,
  Link2,
  Link2Off,
  UserX,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { FadeIn } from "@/components/fade-in";
import { CopyButton } from "@/components/copy-button";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { VIPS_GUILD_ID } from "@/lib/discord-vip-channel-links";
import {
  getVipBotStats,
  getVipLinkOperations,
  getVipOrphanLinks,
  getVipRoster,
  type VipLinkOperationRow,
  type VipRosterFilter,
  type VipRosterRow,
} from "@/lib/queries/vips";

export const metadata = { title: "VIPs" };

const VIPS_PATH = "/vips";
const LIMIT = 50;
/** Admin-DB tag/link join + a bounded MAIN PK-IN hydration and P&L batch —
 *  all indexed. The bound only guards a hung connection / pool exhaustion. */
const VIPS_LIST_TIMEOUT_MS = 15_000;
const VIPS_SIDE_TIMEOUT_MS = 8_000;

const FILTERS: { key: VipRosterFilter; label: string }[] = [
  { key: "all", label: "All VIPs" },
  { key: "linked", label: "Discord linked" },
  { key: "unlinked", label: "Not linked" },
];

function channelUrl(guildId: string, channelId: string) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function memberUrl(memberDiscordUserId: string) {
  return `https://discord.com/users/${memberDiscordUserId}`;
}

function parseFilter(value: string | undefined): VipRosterFilter {
  return value === "linked" || value === "unlinked" ? value : "all";
}

function listHref(filter: VipRosterFilter, offset: number) {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs ? `${VIPS_PATH}?${qs}` : VIPS_PATH;
}

/**
 * Players → VIPs.
 *
 * Two things live here now:
 *  1. the VIP roster — packy.gg users tagged `vip` in the admin DB, with
 *     lifetime money columns (House-POV colours), and
 *  2. the Discord VIP bot surface — which VIP has a private channel linked
 *     in the VIP guild, which Discord member it belongs to, what the bot's
 *     `/link` command did recently, and which links went stale after a tag
 *     was removed.
 *
 * Shell-first: the hero paints immediately; the KPI strip, the roster and
 * the bot-activity legs each stream in their own Suspense boundary (see
 * `loading.tsx` for the matching skeleton shell).
 */
export default async function VipsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/vips");

  const params = await searchParams;
  const offset = Math.max(0, Number(params.offset ?? "0")) || 0;
  const filter = parseFilter(params.filter);

  return (
    <div className="space-y-6">
      <Suspense fallback={<KpiStripSkeleton count={5} />}>
        <VipStatsSection />
      </Suspense>

      <Suspense key={`${filter}-${offset}`} fallback={<VipsListSkeleton />}>
        <VipsListSection offset={offset} filter={filter} />
      </Suspense>

      <Suspense fallback={<BotActivitySkeleton />}>
        <BotActivitySection />
      </Suspense>
    </div>
  );
}

/* ── KPI strip ───────────────────────────────────────────────────── */

async function VipStatsSection() {
  const result = await safeQuery(
    () => getVipBotStats(),
    {
      vipTotal: 0,
      linkedTotal: 0,
      memberLinkedTotal: 0,
      unlinkedTotal: 0,
      orphanLinkTotal: 0,
      operations7d: 0,
      lastOperationAt: null,
    },
    "vips.stats",
    VIPS_SIDE_TIMEOUT_MS,
  );
  const s = result.data;
  const coverage =
    s.vipTotal > 0 ? Math.round((s.linkedTotal / s.vipTotal) * 100) : 0;

  return (
    <FadeIn className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <KpiTile
        label="VIP players"
        value={formatNumber(s.vipTotal)}
        sub="tagged in admin"
        icon={Crown}
        accent="amber"
      />
      <KpiTile
        label="Discord linked"
        value={formatNumber(s.linkedTotal)}
        sub={`${coverage}% of VIPs`}
        icon={Link2}
        accent="cyan"
      />
      <KpiTile
        label="Member bound"
        value={formatNumber(s.memberLinkedTotal)}
        sub="channel + Discord user"
        icon={AtSign}
        accent="purple"
      />
      <KpiTile
        label="Awaiting link"
        value={formatNumber(s.unlinkedTotal)}
        sub="no VIP channel yet"
        icon={Link2Off}
        accent={s.unlinkedTotal > 0 ? "orange" : "blue"}
      />
      <KpiTile
        label="Bot links 7d"
        value={formatNumber(s.operations7d)}
        sub={
          s.lastOperationAt
            ? `last ${formatDateTime(s.lastOperationAt)}`
            : "no bot activity yet"
        }
        icon={Bot}
        accent="blue"
      />
    </FadeIn>
  );
}

/* ── Roster ──────────────────────────────────────────────────────── */

/**
 * House-POV PnL cell — mirrors `PnlCell` in `/users`'s
 * `src/app/(admin)/users/columns.tsx` exactly: user-perspective sign
 * (positive = user in profit = house liability → rose; negative = user
 * down → emerald), same "+"/"-" prefix via `formatCurrency`.
 */
function PnlCell({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="tabular-nums text-muted-foreground">—</span>;
  }
  const isUserProfit = value > 0;
  const isUserLoss = value < 0;
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        isUserProfit && "text-rose-400",
        isUserLoss && "text-emerald-400",
      )}
    >
      {value >= 0 ? "+" : ""}
      {formatCurrency(value)}
    </span>
  );
}

/** Channel + member affordances for one VIP row. */
function DiscordCell({ discord }: { discord: VipRosterRow["discord"] }) {
  if (!discord) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
        <Link2Off className="size-3.5" aria-hidden />
        Not linked
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <a
          href={channelUrl(discord.guildId, discord.channelId)}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-xs font-medium text-cyan-600 hover:bg-cyan-500/20 dark:text-cyan-400"
        >
          <Hash className="size-3" aria-hidden />
          Channel
          <ExternalLink className="size-2.5" aria-hidden />
        </a>
        <CopyButton
          value={discord.channelId}
          label="Channel ID"
          srLabel="Copy Discord channel ID"
        />
      </div>
      {discord.memberDiscordUserId ? (
        <div className="flex items-center gap-1.5">
          <a
            href={memberUrl(discord.memberDiscordUserId)}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <AtSign className="size-3" aria-hidden />
            {discord.memberDiscordUserId}
          </a>
          <CopyButton
            value={discord.memberDiscordUserId}
            label="Discord user ID"
            srLabel="Copy Discord member ID"
          />
        </div>
      ) : (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3" aria-hidden />
          No member bound
        </span>
      )}
    </div>
  );
}

async function VipsListSection({
  offset,
  filter,
}: {
  offset: number;
  filter: VipRosterFilter;
}) {
  const EMPTY: Awaited<ReturnType<typeof getVipRoster>> = {
    items: [],
    total: 0,
  };
  const result = await safeQuery(
    () => getVipRoster({ limit: LIMIT, offset, filter }),
    EMPTY,
    "vips.list",
    VIPS_LIST_TIMEOUT_MS,
  );
  const { items, total } = result.data;
  const listFailed = result.error !== null;

  return (
    <FadeIn className="space-y-3">
      <SectionHeading
        icon={Crown}
        title="VIP accounts"
        action={
          <div className="flex items-center gap-1 rounded-lg border bg-card p-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={listHref(f.key, 0)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
                  f.key === filter
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
        }
      />

      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load the VIP list — the query timed out or failed.
            Refresh to retry.
          </p>
        </div>
      )}

      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">
            {FILTERS.find((f) => f.key === filter)?.label ?? "VIP users"}
          </span>
          <span className="text-xs text-muted-foreground">
            Showing {items.length} of {total}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Crown className="size-6" />
            <span className="text-sm">
              {filter === "linked"
                ? "No VIP has a Discord channel linked yet."
                : filter === "unlinked"
                  ? "Every VIP has a Discord channel linked."
                  : "No VIPs tagged yet."}
            </span>
            <span className="max-w-sm text-center text-xs">
              VIPs are tagged from a player&apos;s profile in Admin → Users, or
              automatically when the bot runs <code>/link</code> in the VIP
              server.
            </span>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Player</th>
                  <th className="pb-2 pr-4 font-medium">Discord</th>
                  <th className="pb-2 pr-4 font-medium">Lifetime PnL</th>
                  <th className="pb-2 pr-4 font-medium">Deposits</th>
                  <th className="pb-2 pr-4 font-medium">Withdrawals</th>
                  <th className="pb-2 pr-4 font-medium">Country</th>
                  <th className="pb-2 font-medium">Tagged at</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((row) => (
                  <tr key={row.userId} className="align-middle">
                    <td className="py-3 pr-4">
                      <Link
                        href={`/users/${row.userId}`}
                        className="font-semibold hover:underline"
                      >
                        {row.username ?? row.userId}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {row.email ?? "—"}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <DiscordCell discord={row.discord} />
                    </td>
                    <td className="py-3 pr-4">
                      <PnlCell value={row.pnl} />
                    </td>
                    <td className="py-3 pr-4 tabular-nums">
                      {row.totalDeposited === null
                        ? "—"
                        : formatCurrency(row.totalDeposited)}
                    </td>
                    <td className="py-3 pr-4 tabular-nums">
                      {row.totalWithdrawn === null
                        ? "—"
                        : formatCurrency(row.totalWithdrawn)}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.country ?? row.countryCode ?? "—"}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {formatDateTime(row.taggedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <PaginationFooter
            offset={offset}
            limit={LIMIT}
            total={total}
            shown={items.length}
            filter={filter}
          />
        )}
      </div>
    </FadeIn>
  );
}

function PaginationFooter({
  offset,
  limit,
  total,
  shown,
  filter,
}: {
  offset: number;
  limit: number;
  total: number;
  shown: number;
  filter: VipRosterFilter;
}) {
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = pageEnd < total;

  return (
    <div className="mt-4 flex items-center justify-between border-t pt-3">
      <span className="text-xs text-muted-foreground">
        {pageStart}–{pageEnd} of {total}
      </span>
      <div className="flex items-center gap-2">
        {hasPrev ? (
          <Link
            href={listHref(filter, Math.max(0, offset - limit))}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            <ChevronLeft className="size-3.5" />
            Previous
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            <ChevronLeft className="size-3.5" />
            Previous
          </span>
        )}
        {hasNext ? (
          <Link
            href={listHref(filter, offset + limit)}
            className="inline-flex h-8 items-center gap-1 rounded-md border bg-background px-3 text-xs font-semibold hover:bg-muted"
          >
            Next
            <ChevronRight className="size-3.5" />
          </Link>
        ) : (
          <span className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-md border px-3 text-xs font-semibold text-muted-foreground/40">
            Next
            <ChevronRight className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Bot activity + stale links ──────────────────────────────────── */

const OPERATION_STYLES: Record<
  VipLinkOperationRow["status"],
  { label: string; className: string }
> = {
  linked: {
    label: "Linked",
    className:
      "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  },
  updated: {
    label: "Updated",
    className:
      "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  already_linked: {
    label: "No change",
    className:
      "bg-muted text-muted-foreground border-border",
  },
};

async function BotActivitySection() {
  const [opsResult, orphanResult] = await Promise.all([
    safeQuery(
      () => getVipLinkOperations(20),
      [] as Awaited<ReturnType<typeof getVipLinkOperations>>,
      "vips.linkOperations",
      VIPS_SIDE_TIMEOUT_MS,
    ),
    safeQuery(
      () => getVipOrphanLinks(20),
      [] as Awaited<ReturnType<typeof getVipOrphanLinks>>,
      "vips.orphanLinks",
      VIPS_SIDE_TIMEOUT_MS,
    ),
  ]);
  const operations = opsResult.data;
  const orphans = orphanResult.data;

  return (
    <FadeIn className="space-y-6">
      <div className="space-y-3">
        <SectionHeading icon={History} title="Bot link activity" />
        <div className="rounded-2xl border bg-card p-4">
          {operations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
              <Bot className="size-6" />
              <span className="text-sm">No bot link runs recorded yet.</span>
              <span className="max-w-sm text-center text-xs">
                Every <code>/link</code> interaction in the VIP server is logged
                here with the channel, the Discord member and whether the VIP
                tag was created.
              </span>
            </div>
          ) : (
            <ul className="divide-y">
              {operations.map((op) => {
                const style = OPERATION_STYLES[op.status];
                return (
                  <li
                    key={op.interactionId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                        style.className,
                      )}
                    >
                      {style.label}
                    </span>
                    <Link
                      href={`/users/${op.userId}`}
                      className="text-sm font-semibold hover:underline"
                    >
                      {op.username ?? op.userId}
                    </Link>
                    <a
                      href={channelUrl(op.guildId, op.channelId)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <Hash className="size-3" aria-hidden />
                      {op.channelId}
                    </a>
                    {op.memberDiscordUserId && (
                      <a
                        href={memberUrl(op.memberDiscordUserId)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        <AtSign className="size-3" aria-hidden />
                        {op.memberDiscordUserId}
                      </a>
                    )}
                    {op.vipTagAdded && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <BadgeCheck className="size-3" aria-hidden />
                        VIP tag created
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      by {op.actorDiscordUserId} · {formatDateTime(op.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {orphans.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={UserX} title="Links without a VIP tag" />
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              These Discord channels are still bound to a player whose VIP tag
              was removed. Re-tag the player or unlink the channel in Discord.
            </p>
            <ul className="mt-3 divide-y divide-amber-500/20">
              {orphans.map((row) => (
                <li
                  key={row.channelId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
                >
                  <Link
                    href={`/users/${row.userId}`}
                    className="text-sm font-semibold hover:underline"
                  >
                    {row.username ?? row.userId}
                  </Link>
                  <a
                    href={channelUrl(VIPS_GUILD_ID, row.channelId)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    <Hash className="size-3" aria-hidden />
                    {row.channelId}
                  </a>
                  <span className="ml-auto text-xs text-muted-foreground">
                    linked {formatDateTime(row.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </FadeIn>
  );
}

/* ── Skeletons ───────────────────────────────────────────────────── */

function VipsListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-3 w-24 rounded" />
        </div>
        <div className="mt-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}

function BotActivitySkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-40 rounded" />
      <div className="rounded-2xl border bg-card p-4">
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
