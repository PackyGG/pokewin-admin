"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2, Pencil, Tv, X } from "lucide-react";

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
import type {
  CreatorSessionResponse,
  StreamSessionStatus,
} from "@/lib/backend-api";

import { setSessionVodUrl } from "./sessions-actions";

/**
 * Sessions-tab table PARTS — the session record's presentation pieces, split
 * out of `sessions-table.tsx` so that file holds only the table/card chrome:
 * the inline Kick-VOD editor, the detail modal, the status styles, the
 * datum/detail primitives and the money/date/duration helpers.
 *
 * (These were shared with a second `/creator-hub/sessions` "All Sessions"
 * surface; that route was removed 2026-07-23, so the Sessions tab is now the
 * only consumer. Kept as its own module — it is a clean presentation/chrome
 * split, and `sessions-table.tsx` is ~800 lines with it folded back in.)
 *
 * House-POV finance colors (whole-site rule):
 *   • Loaded / refunded / converted-out (value the house granted or paid out) → rose.
 *   • Spent (user wagered house-provided fill → house gain)                   → emerald.
 *   • Remaining                                                              → muted.
 *   • Tips + sponsor (house-funded giveaways the creator handed out)         → rose.
 *
 * Client-only. No function props cross the RSC boundary — callers pass
 * serializable rows and the server action is imported directly here.
 */

/**
 * The session shape these parts need: the backend record plus the two
 * admin-DB meta columns. The tab's row type is a structural superset, so it
 * passes without a cast.
 */
export type SessionRowBase = CreatorSessionResponse & {
  kickVodUrl: string | null;
  notes: string | null;
};

export const STATUS_STYLE: Record<StreamSessionStatus, string> = {
  active:
    "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  ended: "border-muted bg-muted/50 text-muted-foreground",
  converted:
    "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

// ── Mobile-card datum ────────────────────────────────────────────────

export function Datum({
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
 * modal (compact={false} there for a roomier layout). All call the same
 * {@link setSessionVodUrl} server action.
 */
export function InlineVodEditor({
  session,
  vodUrl,
  onVodChange,
  compact = true,
}: {
  session: SessionRowBase;
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
 *
 * `subtitle` fills the dialog description (defaults to the bare session id).
 */
export function SessionDetailModal({
  session,
  vodUrl,
  onVodChange,
  onClose,
  subtitle,
  subtitleClassName,
}: {
  session: SessionRowBase | null;
  vodUrl: string | null;
  onVodChange: (sessionId: string, next: string | null) => void;
  onClose: () => void;
  subtitle?: React.ReactNode;
  subtitleClassName?: string;
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
              <DialogDescription
                className={subtitleClassName ?? "font-mono text-[11px]"}
              >
                {subtitle ?? session.id}
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
                  <DetailRow label="Ended" value={fmtDateTime(session.ended_at)} />
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
                    value={<CommunitySpend session={session} />}
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
                  <DetailRow label="Version" value={String(session.version)} />
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

export function DetailSection({
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

export function DetailGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
      {children}
    </div>
  );
}

export function DetailRow({
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
export function sessionCommunitySpendUsd(session: SessionRowBase): number {
  const tips = Number(session.tips_spent_this_session_usd);
  const sponsor = Number(session.sponsorship_spent_this_session_usd);
  return (
    (Number.isFinite(tips) ? tips : 0) +
    (Number.isFinite(sponsor) ? sponsor : 0)
  );
}

export function CommunitySpend({ session }: { session: SessionRowBase }) {
  const total = sessionCommunitySpendUsd(session);
  if (total <= 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-medium text-rose-600 dark:text-rose-400">
      {formatCurrency(total)}
    </span>
  );
}

export function LivePulse() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inline-flex size-full rounded-full bg-amber-500 opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
    </span>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

/** Render a decimal-string USD amount via the shared currency formatter. */
export function usd(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? formatCurrency(n) : `$${value}`;
}

export function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  return formatDateTime(new Date(value));
}

/**
 * Human duration of a session: ended − activated when ended, else (for an
 * active session) now − activated. Null when activated is unparseable.
 */
export function sessionDurationLabel(session: SessionRowBase): string | null {
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
export function stopRowClick(e: React.MouseEvent) {
  e.stopPropagation();
}

/**
 * Don't let Enter/Space inside the inline editor or a link trigger the row's
 * open-on-keydown handler.
 */
export function stopRowKey(e: React.KeyboardEvent) {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
}
