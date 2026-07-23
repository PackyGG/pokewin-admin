"use client";

import { memo, useCallback, useMemo, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";

import type { CreatorSessionRow } from "../_queries/sessions-data";
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
} from "../../../_components/session-parts";

/**
 * Creator Hub — `creators/[id]` **Sessions** tab table (client).
 *
 * Owner spec:
 *   • ONE row per session, showing every available datum.
 *   • Each row is CLICKABLE → a centered modal with the full session detail.
 *   • A **Kick VOD URL per session**, editable INLINE in the row (no modal) AND
 *     in the modal, persisted via {@link setSessionVodUrl} (manager-gated,
 *     audit-logged, ADMIN DB).
 *   • Tip + sponsorship spend surfaced per session.
 *
 * House-POV finance colors (whole site rule):
 *   • Loaded / converted-out (value the house granted / paid out) → rose.
 *   • Spent (user wagered house-provided fill → house gain) → emerald.
 *   • Tips + sponsor (house-funded giveaways the creator handed out) → rose.
 *
 * Client component — receives only serializable session rows (no function
 * props across the RSC boundary); the server action is imported directly.
 * Clicking the VOD-edit control stops row-click propagation so editing the URL
 * never also opens the modal.
 *
 * The VOD editor, the detail modal, the status styles and the money/duration
 * helpers live in `_components/session-parts.tsx`, shared with the All Sessions
 * table so a fix lands on both surfaces at once. Only this surface's own row +
 * mobile-card chrome stays here.
 */

export function SessionsTable({ rows }: { rows: CreatorSessionRow[] }) {
  // VOD URLs are owned client-side after first paint so an inline save (or a
  // save from the modal) reflects instantly everywhere the session is shown,
  // without waiting on the route revalidation. Seeded from the server rows.
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
              <TableHead className="pl-4">Status</TableHead>
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
              <TableHead className="min-w-[200px]">Kick VOD</TableHead>
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

      {/* Centered detail modal — full session datum. */}
      <SessionDetailModal
        session={openRow}
        vodUrl={openRow ? (vodById[openRow.id] ?? null) : null}
        onVodChange={handleVodChange}
        onClose={() => setOpenSessionId(null)}
      />
    </>
  );
}

// ── Desktop row ──────────────────────────────────────────────────────

const SessionRow = memo(function SessionRow({
  session,
  vodUrl,
  onVodChange,
  onOpen,
}: {
  session: CreatorSessionRow;
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
      <TableCell className="pl-4">
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
      {/* Inline VOD editor — clicks here don't bubble to the row (no modal). */}
      <TableCell onClick={stopRowClick} onKeyDown={stopRowKey}>
        <InlineVodEditor
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
  session: CreatorSessionRow;
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
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">
          {activatedAt}
        </span>
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
        <InlineVodEditor
          session={session}
          vodUrl={vodUrl}
          onVodChange={onVodChange}
        />
      </div>
    </div>
  );
});

