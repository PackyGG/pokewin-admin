import Link from "next/link";
import {
  Ticket,
  User as UserIcon,
  Search as SearchIcon,
  ExternalLink,
} from "lucide-react";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber, formatDate } from "@/lib/utils/format";
import {
  searchAffiliateCodes,
  type AffiliateCodeRow,
} from "@/lib/queries/affiliate-codes-lookup";
import { ManageAffiliateCodeDialog } from "./manage-dialog";
import { UsagesDisclosure } from "./usages-disclosure";

/**
 * Server-rendered search results for /insights/affiliate-codes.
 *
 * Runs the indexed lookup (exact code + owner username/email + username
 * prefix) for `query`, then renders a card per matched code. Empty query
 * → a hint; no match → an empty state. Each card surfaces the owner, the
 * affiliate_accounts money figures (House-POV), and a "Manage" dialog +
 * an expandable recent-usages drawer (lazy-loaded, indexed, bounded).
 */
export async function ResultsSection({ query }: { query: string }) {
  const trimmed = query.trim();

  if (!trimmed) {
    return (
      <EmptyState
        icon={<SearchIcon className="size-6 text-muted-foreground" aria-hidden />}
        title="Search for an affiliate code"
        body="Enter an exact code, or an owner's username / email (username prefix also works). Results are read from the live game database."
      />
    );
  }

  const { data: rows, error } = await safeQuery(
    () => searchAffiliateCodes(trimmed, 25),
    [] as AffiliateCodeRow[],
    "affiliate-codes.search",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Couldn't search affiliate codes"
        hint="The lookup failed or timed out. Try again."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Ticket className="size-6 text-muted-foreground" aria-hidden />}
        title="No matching codes"
        body={`Nothing matched "${trimmed}". Code search is exact; owner search matches an exact username / email or a username prefix.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {rows.length === 25
          ? "Showing the first 25 matches — narrow your search to see more."
          : `${rows.length} ${rows.length === 1 ? "match" : "matches"}.`}
      </p>
      {rows.map((row) => (
        <CodeCard key={row.id} row={row} />
      ))}
    </div>
  );
}

function CodeCard({ row }: { row: AffiliateCodeRow }) {
  const ownerLabel = row.owner.username
    ? `@${row.owner.username}`
    : row.owner.email ?? row.owner.id;
  const acc = row.account;

  return (
    <div className="surface-raise rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-sm font-semibold">
              {row.code}
            </span>
            <span className="text-xs text-muted-foreground">
              created {formatDate(row.createdAt)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <UserIcon className="size-3.5 shrink-0" aria-hidden />
            <Link
              href={`/users/${row.owner.id}`}
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
            >
              {ownerLabel}
              <ExternalLink className="size-3 opacity-60" aria-hidden />
            </Link>
            {row.owner.email && row.owner.username && (
              <span className="truncate text-xs">· {row.owner.email}</span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          <ManageAffiliateCodeDialog
            codeId={row.id}
            code={row.code}
            ownerUserId={row.owner.id}
            ownerLabel={ownerLabel}
            availableUsd={acc?.availableUsd ?? 0}
            hasAccount={acc != null}
          />
        </div>
      </div>

      {/* Money breakdown — House POV: every dollar the affiliate earned or
          can still claim is a dollar the house owes → rose. Referred count
          + downstream wager volume are neutral context (wager is
          house-positive but shown as plain context here, not a P&L). */}
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Figure
          label="Earned (lifetime)"
          value={acc ? formatCurrency(acc.totalEarnedUsd) : "—"}
          tone="rose"
        />
        <Figure
          label="Claimable now"
          value={acc ? formatCurrency(acc.availableUsd) : "—"}
          tone="rose"
        />
        <Figure
          label="Paid out"
          value={acc ? formatCurrency(acc.totalPaidOutUsd) : "—"}
          tone="muted"
        />
        <Figure
          label="Referred"
          value={acc ? formatNumber(acc.totalReferred) : "—"}
          tone="muted"
        />
        <Figure
          label="Downstream wager"
          value={acc ? formatCurrency(acc.totalWagerVolumeUsd) : "—"}
          tone="muted"
        />
      </dl>

      {!acc && (
        <p className="mt-2 text-xs text-muted-foreground">
          This owner has no affiliate_accounts row yet (no earnings recorded).
        </p>
      )}

      {/* Recent usages — lazy: the bounded, indexed query only runs when the
          disclosure is opened (Server Action behind the client toggle). */}
      <UsagesDisclosure affiliateUserId={row.owner.id} />
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "rose" | "muted";
}) {
  return (
    <div className="rounded-lg border bg-background/40 px-2.5 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          tone === "rose"
            ? "mt-0.5 text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400"
            : "mt-0.5 text-sm font-semibold tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/40 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border bg-background/50">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
