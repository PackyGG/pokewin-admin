"use client";

import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Radio } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";

import type { AllCreatorSessionRow } from "../_queries/all-sessions-data";
import { ForceEndSessionButton } from "./force-end-session-dialog";
import {
  CommunitySpend,
  Datum,
  InlineVodEditor,
  LivePulse,
  SessionDetailModal,
  STATUS_STYLE,
  sessionDurationLabel,
  stopRowClick,
  stopRowKey,
  usd,
} from "../../_components/session-parts";

/**
 * Creator Hub — `/creator-hub/sessions` (All Sessions) table (client).
 *
 * The per-creator Sessions tab (`creators/[id]/_components/sessions-table.tsx`)
 * renders the same session record; everything identical between the two — the
 * inline Kick VOD editor, the detail modal, the status styles, the money and
 * duration helpers — lives in `_components/session-parts.tsx` so a fix lands on
 * both surfaces at once. This file holds only what is unique to All Sessions:
 * a leading **Creator** column (avatar + username, linked to the creator's Hub
 * profile), a "Watch stream" link, and the force-end control.
 *
 * House-POV finance colors (whole-site rule, identical to the per-creator tab):
 *   • Loaded / converted-out (value the house granted / paid out) → rose.
 *   • Spent (user wagered house-provided fill → house gain) → emerald.
 *   • Remaining → muted.
 *   • Tips + sponsor (house-funded giveaways) → rose.
 *
 * Client component — receives only serializable rows (no function props across
 * the RSC boundary). Clicking the VOD editor or the Creator link stops
 * row-click propagation so neither also opens the session modal.
 */

export function AllSessionsTable({ rows }: { rows: AllCreatorSessionRow[] }) {
  // VOD URLs are owned client-side after first paint so an inline save (or a
  // save from the modal) reflects instantly, without waiting on revalidation.
  const [vodById, setVodById] = useState<Record<string, string | null>>(() => {
    const seed: Record<string, string | null> = {};
    for (const r of rows) seed[r.id] = r.kickVodUrl;
    return seed;
  });

  // Which session's detail modal is open (null = none).
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const handleVodChange = useCallback(
    (sessionId: string, next: string | null) => {
      setVodById((prev) => ({ ...prev, [sessionId]: next }));
    },
    [],
  );

  const openRow = useMemo(
    () => rows.find((r) => r.id === openSessionId) ?? null,
    [rows, openSessionId],
  );

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="divide-y divide-border/60 lg:hidden">
        {rows.map((s) => (
          <SessionMobileCard
            key={s.id}
            session={s}
            vodUrl={vodById[s.id] ?? null}
            onVodChange={handleVodChange}
            onOpen={() => setOpenSessionId(s.id)}
          />
        ))}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Creator</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="text-right">Loaded</TableHead>
              <TableHead className="text-right">Spent</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead className="text-right">Converted</TableHead>
              <TableHead className="text-right">
                Tips + sponsor
                <div className="text-[10px] font-normal normal-case text-muted-foreground/70">
                  house-funded
                </div>
              </TableHead>
              <TableHead className="min-w-[320px]">Kick VOD / actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                vodUrl={vodById[s.id] ?? null}
                onVodChange={handleVodChange}
                onOpen={() => setOpenSessionId(s.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Centered detail modal — full session datum. Shared with the
          per-creator tab; only the subtitle differs (creator identity here,
          a bare session id there). */}
      <SessionDetailModal
        session={openRow}
        vodUrl={openRow ? (vodById[openRow.id] ?? null) : null}
        onVodChange={handleVodChange}
        onClose={() => setOpenSessionId(null)}
        subtitleClassName="flex items-center gap-2"
        subtitle={
          openRow ? (
            <>
              <Avatar size="sm" className="shrink-0">
                {openRow.creatorImage && (
                  <AvatarImage
                    src={openRow.creatorImage}
                    alt={creatorLabel(openRow)}
                  />
                )}
                <AvatarFallback>{creatorInitial(openRow)}</AvatarFallback>
              </Avatar>
              <Link
                href={`/creator-hub/creators/${openRow.creatorId}`}
                className="font-medium text-foreground hover:underline"
              >
                {creatorLabel(openRow)}
              </Link>
              <span className="font-mono text-[11px] text-muted-foreground">
                · {openRow.id}
              </span>
            </>
          ) : undefined
        }
      />
    </>
  );
}

// ── Creator cell ─────────────────────────────────────────────────────

/**
 * Avatar + username linked to the creator's Hub profile. Clicks stop
 * propagation so opening a creator never also opens the session modal.
 */
function CreatorCell({
  session,
  size = "sm",
}: {
  session: AllCreatorSessionRow;
  size?: "sm" | "default";
}) {
  const name = creatorLabel(session);
  return (
    <Link
      href={`/creator-hub/creators/${session.creatorId}`}
      onClick={stopRowClick}
      onKeyDown={stopRowKey}
      className="inline-flex min-w-0 items-center gap-2 rounded-md outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      title={name}
    >
      <Avatar size={size} className="shrink-0">
        {session.creatorImage && (
          <AvatarImage src={session.creatorImage} alt={name} />
        )}
        <AvatarFallback>{creatorInitial(session)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-sm font-medium">{name}</span>
    </Link>
  );
}

// ── Desktop row ──────────────────────────────────────────────────────

const SessionRow = memo(function SessionRow({
  session,
  vodUrl,
  onVodChange,
  onOpen,
}: {
  session: AllCreatorSessionRow;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  onOpen: () => void;
}) {
  const activatedAt = useMemo(
    () => formatDateTime(new Date(session.activated_at)),
    [session.activated_at],
  );
  const duration = useMemo(() => sessionDurationLabel(session), [session]);

  return (
    <TableRow
      onClick={onOpen}
      tabIndex={0}
      role="button"
      aria-label="Open session details"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer"
    >
      {/* Creator — link stops propagation so it never opens the modal. */}
      <TableCell className="max-w-[200px] pl-4">
        <CreatorCell session={session} />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {session.status === "active" && <LivePulse />}
          <Badge variant="outline" className={STATUS_STYLE[session.status]}>
            {session.status}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <div>{activatedAt}</div>
        {duration && (
          <div className="text-[10px] text-muted-foreground/70">{duration}</div>
        )}
      </TableCell>
      {/* Loaded = house-provided fill granted to the creator → rose */}
      <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
        {usd(session.fill_loaded_usd)}
      </TableCell>
      {/* Spent = user wagered the fill → house gain → emerald */}
      <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
        {usd(session.fill_spent_usd)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {usd(session.fill_remaining_usd)}
      </TableCell>
      {/* Converted-out = value paid out to the creator as a voucher → rose */}
      <TableCell className="text-right tabular-nums">
        {session.converted_to_raw_usd != null ? (
          <span className="text-rose-600 dark:text-rose-400">
            {usd(session.converted_to_raw_usd)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      {/* Tips + sponsor = house-funded giveaways → rose */}
      <TableCell className="text-right tabular-nums">
        <CommunitySpend session={session} />
      </TableCell>
      {/* VOD editor + watch-stream + force-end — clicks here don't bubble. */}
      <TableCell onClick={stopRowClick} onKeyDown={stopRowKey}>
        <SessionControls
          session={session}
          vodUrl={vodUrl}
          onVodChange={onVodChange}
        />
      </TableCell>
    </TableRow>
  );
});

// ── Mobile card ──────────────────────────────────────────────────────

const SessionMobileCard = memo(function SessionMobileCard({
  session,
  vodUrl,
  onVodChange,
  onOpen,
}: {
  session: AllCreatorSessionRow;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  onOpen: () => void;
}) {
  const activatedAt = useMemo(
    () => formatDateTime(new Date(session.activated_at)),
    [session.activated_at],
  );
  const duration = useMemo(() => sessionDurationLabel(session), [session]);

  return (
    <div className="px-3 py-3">
      {/* Creator at the top — its own link (stops propagation). */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <CreatorCell session={session} />
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">
          {activatedAt}
        </span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start justify-between gap-2 text-left"
        aria-label="Open session details"
      >
        <div className="flex items-center gap-2">
          {session.status === "active" && <LivePulse />}
          <Badge variant="outline" className={STATUS_STYLE[session.status]}>
            {session.status}
          </Badge>
        </div>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 grid w-full grid-cols-2 gap-x-3 gap-y-1 text-left text-xs"
        aria-label="Open session details"
      >
        <Datum label="Loaded" className="text-rose-600 dark:text-rose-400">
          {usd(session.fill_loaded_usd)}
        </Datum>
        <Datum label="Spent" className="text-emerald-600 dark:text-emerald-400">
          {usd(session.fill_spent_usd)}
        </Datum>
        <Datum label="Remaining" className="text-muted-foreground">
          {usd(session.fill_remaining_usd)}
        </Datum>
        <Datum
          label="Converted"
          className={
            session.converted_to_raw_usd != null
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground"
          }
        >
          {session.converted_to_raw_usd != null
            ? usd(session.converted_to_raw_usd)
            : "—"}
        </Datum>
        <Datum label="Tips + sponsor">
          <CommunitySpend session={session} />
        </Datum>
        {duration && (
          <Datum label="Duration" className="text-muted-foreground">
            {duration}
          </Datum>
        )}
      </button>
      <div className="mt-2.5">
        <SessionControls
          session={session}
          vodUrl={vodUrl}
          onVodChange={onVodChange}
        />
      </div>
    </div>
  );
});

// ── Watch stream + row controls ──────────────────────────────────────

/**
 * "Watch stream" link to the creator's Kick channel
 * (`https://kick.com/<handle>`), opened in a new tab. Rendered only when the
 * creator has a linked Kick handle (admin DB `creator_socials`); omitted
 * otherwise. Neutral styling — this is a navigation action, not a money value,
 * so it carries no House-POV finance color. Clicks stop row propagation.
 */
function WatchStreamButton({ handle }: { handle: string | null }) {
  if (!handle) return null;
  const url = `https://kick.com/${handle}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopRowClick}
      onKeyDown={stopRowKey}
      title={`Watch on Kick · ${url}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/50"
    >
      <Radio className="size-3.5 shrink-0" />
      <span>Watch stream</span>
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

/**
 * The per-row action cluster: the inline Kick VOD editor (kept — owner
 * confirmed), then to its RIGHT a "Watch stream" link (when the creator has a
 * linked Kick channel) and, for an ACTIVE session only, a destructive
 * "Force end" confirm button. Shared by the desktop row + the mobile card.
 */
function SessionControls({
  session,
  vodUrl,
  onVodChange,
  compact = true,
}: {
  session: AllCreatorSessionRow;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <InlineVodEditor
        session={session}
        vodUrl={vodUrl}
        onVodChange={onVodChange}
        compact={compact}
      />
      <WatchStreamButton handle={session.creatorKickHandle} />
      {session.status === "active" && (
        <ForceEndSessionButton
          userId={session.user_id}
          sessionId={session.id}
        />
      )}
    </div>
  );
}

/** Display label for the owning creator — username or a short id fallback. */
function creatorLabel(session: AllCreatorSessionRow): string {
  if (session.creatorUsername && session.creatorUsername.trim().length > 0) {
    return session.creatorUsername;
  }
  return `${session.creatorId.slice(0, 8)}…`;
}

/** Single-character avatar fallback — first letter of the label, uppercased. */
function creatorInitial(session: AllCreatorSessionRow): string {
  const label = creatorLabel(session);
  const ch = label.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}
