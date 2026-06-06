"use client";

import { memo, useCallback, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Check,
  ExternalLink,
  Loader2,
  Pencil,
  Tv,
  X,
} from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { StreamSessionStatus } from "@/lib/backend-api";

import type { CreatorSessionRow } from "../_queries/sessions-data";
import { setSessionVodUrl } from "./sessions-actions";

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
 */

const STATUS_STYLE: Record<StreamSessionStatus, string> = {
  active:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  ended: "border-muted bg-muted/50 text-muted-foreground",
  converted:
    "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

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

function Datum({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("tabular-nums", className)}>{children}</div>
    </div>
  );
}

// ── Inline VOD editor ────────────────────────────────────────────────

/**
 * The Kick VOD URL cell — a read view (open link / "Add VOD") that flips to an
 * inline input. Shared verbatim by the desktop row, the mobile card, and the
 * modal (compact={false} there for a roomier layout). All three call the same
 * {@link setSessionVodUrl} server action.
 */
function InlineVodEditor({
  session,
  vodUrl,
  onVodChange,
  compact = true,
}: {
  session: CreatorSessionRow;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(vodUrl ?? "");
  const [isPending, startTransition] = useTransition();

  const hasValue = !!vodUrl && vodUrl.trim().length > 0;

  function beginEdit() {
    setDraft(vodUrl ?? "");
    setEditing(true);
  }

  function cancel() {
    setDraft(vodUrl ?? "");
    setEditing(false);
  }

  function persist(next: string) {
    startTransition(async () => {
      try {
        const res = await setSessionVodUrl({
          sessionId: session.id,
          targetUserId: session.user_id,
          vodUrl: next,
        });
        onVodChange(session.id, res.kickVodUrl);
        setEditing(false);
        toast.success(res.kickVodUrl ? "VOD link saved" : "VOD link cleared");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not save VOD link",
        );
      }
    });
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://kick.com/…/videos/…"
          autoFocus
          disabled={isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") persist(draft.trim());
            if (e.key === "Escape") cancel();
          }}
          className="h-8"
        />
        <Button
          type="button"
          size="icon"
          variant="default"
          className="size-8 shrink-0"
          onClick={() => persist(draft.trim())}
          disabled={isPending}
          aria-label="Save VOD link"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          onClick={cancel}
          disabled={isPending}
          aria-label="Cancel"
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {hasValue ? (
        <>
          <a
            href={vodUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-green-600 hover:underline dark:text-green-400",
              compact && "max-w-[150px]",
            )}
            title={vodUrl!}
          >
            <Tv className="size-3.5 shrink-0" />
            <span className="truncate">VOD</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            onClick={beginEdit}
            disabled={isPending}
            aria-label="Edit VOD link"
          >
            <Pencil className="size-3.5" />
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={beginEdit}
          disabled={isPending}
        >
          <Tv className="mr-1.5 size-3.5" />
          Add VOD
        </Button>
      )}
    </div>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────

/**
 * Centered modal with the full session detail — every datum the backend record
 * carries, grouped (timeline / fill economics / community spend / conversion /
 * meta), plus the VOD editor again. House-POV colors throughout.
 */
function SessionDetailModal({
  session,
  vodUrl,
  onVodChange,
  onClose,
}: {
  session: CreatorSessionRow | null;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!session} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {session && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {session.status === "active" && <LivePulse />}
                <span>Session detail</span>
                <Badge
                  variant="outline"
                  className={STATUS_STYLE[session.status]}
                >
                  {session.status}
                </Badge>
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px]">
                {session.id}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              {/* Kick VOD — editable here too */}
              <DetailSection title="Kick VOD">
                <InlineVodEditor
                  session={session}
                  vodUrl={vodUrl}
                  onVodChange={onVodChange}
                  compact={false}
                />
              </DetailSection>

              {/* Timeline */}
              <DetailSection title="Timeline">
                <DetailGrid>
                  <DetailRow
                    label="Activated"
                    value={fmtDateTime(session.activated_at)}
                  />
                  <DetailRow
                    label="First bet"
                    value={fmtDateTime(session.first_bet_at)}
                  />
                  <DetailRow
                    label="Ended"
                    value={fmtDateTime(session.ended_at)}
                  />
                  <DetailRow
                    label="Auto-end at"
                    value={fmtDateTime(session.auto_end_at)}
                  />
                  <DetailRow
                    label="Converted"
                    value={fmtDateTime(session.converted_at)}
                  />
                  <DetailRow
                    label="Duration"
                    value={sessionDurationLabel(session) ?? "—"}
                  />
                </DetailGrid>
              </DetailSection>

              {/* Fill economics */}
              <DetailSection title="Fill economics">
                <DetailGrid>
                  <DetailRow
                    label="Loaded"
                    value={usd(session.fill_loaded_usd)}
                    valueClass="text-rose-600 dark:text-rose-400"
                  />
                  <DetailRow
                    label="Spent (wagered)"
                    value={usd(session.fill_spent_usd)}
                    valueClass="text-emerald-600 dark:text-emerald-400"
                  />
                  <DetailRow
                    label="Refunded"
                    value={usd(session.fill_refunded_usd)}
                    valueClass="text-rose-600 dark:text-rose-400"
                  />
                  <DetailRow
                    label="Remaining"
                    value={usd(session.fill_remaining_usd)}
                  />
                  <DetailRow
                    label="Ending balance"
                    value={
                      session.ending_balance_usd != null
                        ? usd(session.ending_balance_usd)
                        : "—"
                    }
                  />
                </DetailGrid>
              </DetailSection>

              {/* Community spend (tips + sponsorship) */}
              <DetailSection title="Community spend (house-funded)">
                <DetailGrid>
                  <DetailRow
                    label="Tips this session"
                    value={usd(session.tips_spent_this_session_usd)}
                    valueClass={
                      Number(session.tips_spent_this_session_usd) > 0
                        ? "text-rose-600 dark:text-rose-400"
                        : undefined
                    }
                  />
                  <DetailRow
                    label="Sponsorship this session"
                    value={usd(session.sponsorship_spent_this_session_usd)}
                    valueClass={
                      Number(session.sponsorship_spent_this_session_usd) > 0
                        ? "text-rose-600 dark:text-rose-400"
                        : undefined
                    }
                  />
                  <DetailRow
                    label="Total community spend"
                    value={
                      <CommunitySpend session={session} />
                    }
                  />
                </DetailGrid>
              </DetailSection>

              {/* Conversion */}
              <DetailSection title="Conversion">
                <DetailGrid>
                  <DetailRow
                    label="Converted to raw"
                    value={
                      session.converted_to_raw_usd != null
                        ? usd(session.converted_to_raw_usd)
                        : "—"
                    }
                    valueClass={
                      session.converted_to_raw_usd != null
                        ? "text-rose-600 dark:text-rose-400"
                        : undefined
                    }
                  />
                  <DetailRow
                    label="Rate snapshot"
                    value={
                      session.conversion_rate_bps_snapshot != null
                        ? `${(session.conversion_rate_bps_snapshot / 100).toFixed(2)}% (${session.conversion_rate_bps_snapshot} bps)`
                        : "—"
                    }
                  />
                </DetailGrid>
              </DetailSection>

              {/* Meta / identifiers */}
              <DetailSection title="Identifiers">
                <DetailGrid>
                  <DetailRow label="Deal id" value={session.deal_id} mono />
                  <DetailRow label="User id" value={session.user_id} mono />
                  <DetailRow
                    label="Version"
                    value={String(session.version)}
                  />
                  <DetailRow
                    label="Created"
                    value={fmtDateTime(session.created_at)}
                  />
                </DetailGrid>
              </DetailSection>

              {session.notes && (
                <DetailSection title="Notes">
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {session.notes}
                  </p>
                </DetailSection>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
      {children}
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClass,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right tabular-nums",
          mono && "max-w-[55%] truncate font-mono text-xs",
          valueClass,
        )}
        title={mono && typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────

/**
 * The house-funded amount a creator handed to their community this session:
 * tips gifted + balance sponsored, both from house-provided fill. House-POV →
 * rose when non-zero; $0 reads muted "—".
 */
function sessionCommunitySpendUsd(session: CreatorSessionRow): number {
  const tips = Number(session.tips_spent_this_session_usd);
  const sponsor = Number(session.sponsorship_spent_this_session_usd);
  return (
    (Number.isFinite(tips) ? tips : 0) +
    (Number.isFinite(sponsor) ? sponsor : 0)
  );
}

function CommunitySpend({ session }: { session: CreatorSessionRow }) {
  const total = sessionCommunitySpendUsd(session);
  if (total <= 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-medium text-rose-600 dark:text-rose-400">
      {formatCurrency(total)}
    </span>
  );
}

function LivePulse() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full rounded-full bg-amber-500 opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

/** Render a decimal-string USD amount via the shared currency formatter. */
function usd(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? formatCurrency(n) : `$${value}`;
}

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  return formatDateTime(new Date(value));
}

/**
 * Human duration of a session: ended − activated when ended, else (for an
 * active session) now − activated. Null when activated is unparseable.
 */
function sessionDurationLabel(session: CreatorSessionRow): string | null {
  const start = new Date(session.activated_at).getTime();
  if (!Number.isFinite(start)) return null;
  const endRaw = session.ended_at ? new Date(session.ended_at).getTime() : NaN;
  const end = Number.isFinite(endRaw) ? endRaw : Date.now();
  const ms = end - start;
  if (ms < 0) return null;
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const live = session.ended_at ? "" : " (ongoing)";
  if (h === 0) return `${m}m${live}`;
  return `${h}h ${m}m${live}`;
}

/** Prevent a click inside a cell/control from bubbling to the row (no modal). */
function stopRowClick(e: React.MouseEvent) {
  e.stopPropagation();
}

function stopRowKey(e: React.KeyboardEvent) {
  // Don't let Enter/Space inside the inline editor trigger the row's
  // open-on-keydown handler.
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
}
