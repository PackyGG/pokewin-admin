/**
 * The wire contract for the DURABLE inbound path from the antifraud backend:
 * the signed `/api/antifraud/ingest` webhook.
 *
 * TOPOLOGY — there is exactly ONE live wire and ONE durable wire:
 *
 *     monitor service ──WebSocket──▶ /api/antifraud/monitor/stream ──SSE──▶ browser
 *     monitor backend ──signed POST─▶ /api/antifraud/ingest ──▶ admin DB
 *
 * LIVE awareness is the monitor stream (`ANTIFRAUD_MONITOR_API_URL` /
 * `ANTIFRAUD_MONITOR_API_TOKEN`, ticket-authenticated WebSocket, `{id, type,
 * at, data}` replayable envelope). Its browser client lives with the pages that consume it
 * (`src/app/(antifraud)/antifraud/_components/monitor-stream.ts`).
 *
 * This module is the SYSTEM OF RECORD side: a signal POSTed here is persisted
 * (and opened as a case) even when no analyst has the dashboard open.
 * A second, parallel SSE proxy used to live here as well; it spoke an envelope
 * and an event vocabulary the service never emitted, so it could not receive a
 * frame and was removed.
 *
 * Isomorphic on purpose (no server-only imports): the ingest route parses with
 * it, and it must stay cheap to import.
 */

import { isNonActionableRewardEnrollmentSignal } from "./signal-display";

// ─── Wire contract ────────────────────────────────────────────────────────

/** Severity vocabulary, shared with `antifraud_signals.severity`. */
export type AntifraudSeverity = "low" | "medium" | "high" | "critical";

/** A fraud signal as the backend POSTs it to `/api/antifraud/ingest`. */
export type AntifraudSignalEvent = {
  type: "signal";
  /** The backend's own event id — the idempotency key for /ingest. */
  id: string;
  /** Rule key: 'multi_account' | 'bonus_abuse' | 'vpn' | 'chargeback' | … */
  kind: string;
  severity: AntifraudSeverity;
  /** 0–100. */
  riskScore?: number | null;
  /** MAIN-DB `user.id` of the account the signal is about. */
  userId?: string | null;
  username?: string | null;
  /** One-line human summary rendered in the queue. */
  summary: string;
  /** Free-form rule detail. Rendered as JSON on the review. */
  payload?: Record<string, unknown> | null;
  /** ISO-8601. */
  at: string;
};

/**
 * Parse + validate one delivered event. Anything that isn't a recognised,
 * well-formed signal is dropped rather than trusted — the backend is a separate
 * service and this is the boundary where its output stops being assumed
 * correct.
 */
export function parseAntifraudEvent(raw: unknown): AntifraudSignalEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "signal") return null;
  if (typeof obj.id !== "string" || typeof obj.kind !== "string") return null;
  if (typeof obj.summary !== "string") return null;

  return {
    type: "signal",
    id: obj.id,
    kind: obj.kind,
    severity: normalizeSeverity(obj.severity),
    riskScore: normalizeScore(obj.riskScore),
    userId: typeof obj.userId === "string" ? obj.userId : null,
    username: typeof obj.username === "string" ? obj.username : null,
    summary: obj.summary.slice(0, 500),
    payload:
      obj.payload && typeof obj.payload === "object"
        ? (obj.payload as Record<string, unknown>)
        : null,
    at: typeof obj.at === "string" ? obj.at : new Date().toISOString(),
  };
}

export function normalizeSeverity(value: unknown): AntifraudSeverity {
  return value === "low" || value === "high" || value === "critical"
    ? value
    : "medium";
}

export function normalizeScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Severity ranking, for "is this worth a ping?" decisions. */
export const SEVERITY_RANK: Record<AntifraudSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * The severity at or above which an incoming signal notifies the on-call staff
 * (see the ingest route). Below this a signal is persisted silently and shows
 * up in the queue without waking anybody.
 */
export const NOTIFY_SEVERITY_FLOOR: AntifraudSeverity = "high";

/** Signup scores at or above this value always need an account review. */
export const SIGNUP_REVIEW_SCORE_FLOOR = 50;

/**
 * High- and critical-risk signup scores are explicit queue contracts aligned
 * with the canonical 50-point review floor.
 */
export function shouldOpenReviewForSignal(
  signal: Pick<AntifraudSignalEvent, "kind" | "riskScore" | "severity">,
): boolean {
  if (isNonActionableRewardEnrollmentSignal(signal.kind)) return false;
  return (
    signal.kind === "abstract_email_catchall" ||
    signal.kind === "behavioral_rule_match" ||
    ((signal.kind === "high_risk_signup" ||
      signal.kind === "critical_risk_signup") &&
      signal.riskScore !== null &&
      signal.riskScore !== undefined &&
      signal.riskScore >= SIGNUP_REVIEW_SCORE_FLOOR) ||
    SEVERITY_RANK[signal.severity] >= SEVERITY_RANK[NOTIFY_SEVERITY_FLOOR]
  );
}
