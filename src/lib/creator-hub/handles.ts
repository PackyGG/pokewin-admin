import "server-only";

import { logWarn } from "@/lib/errors/logger";

/**
 * Creator-Hub social-handle normalization.
 *
 * The only surviving piece of the removed Kick + Twitter/X RapidAPI data
 * layer: the natural-key normalizer creators' linked handles are stored and
 * compared under. Consumed by All Sessions (`creatorKickHandle` →
 * `kick.com/<handle>`) and the admin socials query.
 *
 * SERVER-ONLY (this module imports `server-only`); call from Server
 * Components / Server Actions, never from a client component.
 */

/**
 * Normalize a user-entered handle to the natural key used everywhere
 * (lowercased, no leading `@`, no surrounding whitespace, and — for pasted
 * profile URLs — the trailing path segment). Returns `null` for an empty /
 * unusable input so callers can show the "No account linked" state.
 *
 * Examples:
 *   "@PackyGG"                         → "packygg"
 *   "https://kick.com/Trainwreckstv/"  → "trainwreckstv"
 *   "x.com/packydotgg?lang=en"         → "packydotgg"
 */
function normalizeHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = input.trim();
  if (!h) return null;

  // If it looks like a URL, take the first non-empty path segment.
  if (/^https?:\/\//i.test(h) || h.includes("/")) {
    try {
      const url = new URL(h.startsWith("http") ? h : `https://${h}`);
      const seg = url.pathname.split("/").filter(Boolean)[0];
      if (seg) h = seg;
    } catch {
      // Not a parseable URL — fall through and clean the raw string.
      const seg = h.split("/").filter(Boolean).pop();
      if (seg) h = seg;
    }
  }

  h = h.replace(/^@+/, "").trim().toLowerCase();
  // Strip an accidental query/fragment tail if the URL parse didn't catch it.
  h = h.split(/[?#]/)[0];
  // Valid Kick/Twitter handles are word-chars + dot/underscore/hyphen.
  if (!/^[a-z0-9._-]+$/.test(h)) {
    logWarn(
      "creator-hub.handles",
      `normalizeHandle rejected an unexpected handle shape (len=${h.length})`,
    );
    return null;
  }
  return h;
}

/**
 * Resolve a linked handle for "is this creator linked?" checks. Uses
 * {@link normalizeHandle} when possible; otherwise accepts a trimmed raw
 * username so valid handles that fail strict normalization still count as
 * linked (the Creator tab stores handles as-entered).
 */
export function resolveLinkedHandle(
  input: string | null | undefined,
): string | null {
  const normalized = normalizeHandle(input);
  if (normalized) return normalized;
  const raw = input?.trim().replace(/^@+/, "");
  if (!raw || raw.toLowerCase() === "pending") return null;
  if (raw.length > 100) return null;
  return raw.toLowerCase();
}
