/**
 * Per-user ("direct") notification contract — the personal feed, as opposed to
 * the fan-out-on-read broadcast in `@/lib/announcement-payload`.
 *
 * An announcement is ONE row with ONE shared payload for everyone, so it can
 * never carry per-recipient content. These endpoints write one row per user,
 * each with its own `payload` — that is the whole reason they exist (the first
 * use case being a promo-code campaign where every account gets a unique code).
 *
 * MIRRORS the backend contract 1:1 (PackyGG/backend#461):
 *   POST /v1/admin/notifications        single user, payload + dedupe optional
 *   POST /v1/admin/notifications/bulk   1–1000 items, dedupe REQUIRED per item
 *
 * Backend-enforced rules (each one 400s — note the OpenAPI schema says 422 but
 * the runtime status is 400):
 *   category    "rewards" | "system" only. `transaction` is producer-owned and
 *               `news` is announcements-only.
 *   type        1–64 chars. An i18n KEY, not display copy — the client maps it
 *               to a localized template.
 *   dedupe_key  1–200 chars, required on every bulk item.
 *   payload     ≤ 4096 bytes serialized. Unknown keys pass through untouched
 *               (unlike announcements, where the backend strips them).
 *   payload.url        http(s) only — javascript:/data: rejected.
 *   payload.image_url  ImageKit host only.
 *   items       1–1000 per bulk request.
 *
 * Validating admin-side keeps a bad value inside the composer with a usable
 * message instead of surfacing as an opaque 400 on chunk 12 of 17. Both the
 * client composer and the server actions run these same functions.
 *
 * Client-importable on purpose (no `server-only`) — the composer needs the
 * same rules the actions enforce.
 */

import {
  IMAGEKIT_URL_PREFIX,
  isHttpUrl,
  isImageKitUrl,
} from "@/lib/announcement-payload";

/** Backend `notification_category` values this admin surface may write. */
export const USER_NOTIFICATION_CATEGORIES = ["rewards", "system"] as const;
export type UserNotificationCategory =
  (typeof USER_NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_TYPE_MAX = 64;
export const NOTIFICATION_DEDUPE_KEY_MAX = 200;
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 4096;
export const NOTIFICATION_URL_MAX = 2048;

/** Hard per-request item cap. */
export const BULK_MAX_ITEMS = 1000;
/**
 * Documented body cap. Two limits bind independently — 1000 items OR 1 MB,
 * whichever hits first — and exceeding the byte limit is a 413, not a 400.
 * A typical item (better-auth id + code + `campaign:user_id` key) is ~150
 * bytes so 1000 items ≈ 147 KB, but kilobyte-scale payloads hit bytes first.
 */
export const BULK_MAX_BODY_BYTES = 1_000_000;
/**
 * What we actually chunk against. Deliberately below the real cap so the
 * request envelope (`category` / `type` / JSON scaffolding) plus any
 * transport overhead can never push a chunk over the line.
 */
export const BULK_BODY_BUDGET_BYTES = 900_000;

/**
 * Hard ceiling on a reward-campaign code's value (owner rule, 2026-07-23:
 * "max max $100 per code"). Enforced BOTH in the composer and in the server
 * action — the client check is a courtesy, the server one is the boundary.
 *
 * Lives here rather than next to the code-derivation helpers because those are
 * `server-only` and the composer is a client component; a second copy of this
 * number is exactly the kind of thing that drifts.
 */
export const REWARD_MAX_VALUE_USD = 100;

/** Arbitrary interpolation data — the point of the contract. */
export type NotificationPayload = Record<string, unknown>;

/** Wire shape of one bulk item. `dedupe_key` is required here. */
export type BulkNotificationItem = {
  user_id: string;
  payload?: NotificationPayload;
  dedupe_key: string;
};

export function isUserNotificationCategory(
  value: unknown,
): value is UserNotificationCategory {
  return (
    typeof value === "string" &&
    (USER_NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Serialized byte length — the unit both the 4096 payload cap and the 1 MB
 * body cap are measured in. `TextEncoder` exists in both runtimes. */
export function jsonByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ── Field validation ────────────────────────────────────────────────────

/** Returns an error message, or null when valid. */
export function validateNotificationType(type: string): string | null {
  const trimmed = type.trim();
  if (!trimmed) return "Type is required — it's the i18n key the client renders";
  if (trimmed.length > NOTIFICATION_TYPE_MAX) {
    return `Type must be ${NOTIFICATION_TYPE_MAX} characters or less`;
  }
  return null;
}

export function validateDedupeKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "Dedupe key is required";
  if (trimmed.length > NOTIFICATION_DEDUPE_KEY_MAX) {
    return `Dedupe key must be ${NOTIFICATION_DEDUPE_KEY_MAX} characters or less (got ${trimmed.length})`;
  }
  return null;
}

export type PayloadValidation =
  | { ok: true; payload: NotificationPayload | undefined }
  | { ok: false; error: string };

/**
 * Validates an already-parsed payload object against every rule the backend
 * enforces. Returns `payload: undefined` for an empty object so the request
 * omits the key entirely rather than sending `{}`.
 */
export function validateNotificationPayload(value: unknown): PayloadValidation {
  if (value === undefined || value === null) return { ok: true, payload: undefined };

  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Payload must be a JSON object, e.g. {\"code\":\"PACKY-A1B2\"}" };
  }

  const payload = value as NotificationPayload;
  if (Object.keys(payload).length === 0) return { ok: true, payload: undefined };

  const url = payload.url;
  if (url !== undefined && url !== null) {
    if (typeof url !== "string" || !isHttpUrl(url)) {
      return {
        ok: false,
        error: "payload.url must be a full http:// or https:// URL",
      };
    }
    if (url.length > NOTIFICATION_URL_MAX) {
      return { ok: false, error: "payload.url is too long (max 2048 characters)" };
    }
  }

  const imageUrl = payload.image_url;
  if (imageUrl !== undefined && imageUrl !== null) {
    if (typeof imageUrl !== "string" || !isImageKitUrl(imageUrl)) {
      return {
        ok: false,
        error: `payload.image_url must be an ImageKit URL (${IMAGEKIT_URL_PREFIX}…) — any other host is rejected`,
      };
    }
    if (imageUrl.length > NOTIFICATION_URL_MAX) {
      return {
        ok: false,
        error: "payload.image_url is too long (max 2048 characters)",
      };
    }
  }

  const size = jsonByteSize(payload);
  if (size > NOTIFICATION_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: `Payload is ${size} bytes — the limit is ${NOTIFICATION_PAYLOAD_MAX_BYTES}`,
    };
  }

  return { ok: true, payload };
}

/** Parse + validate the composer's raw JSON textarea. Empty text = no payload. */
export function parsePayloadJson(raw: string): PayloadValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, payload: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `Payload isn't valid JSON — ${err instanceof Error ? err.message : "parse failed"}`,
    };
  }
  return validateNotificationPayload(parsed);
}

// ── Campaign slug + dedupe keys ─────────────────────────────────────────

/**
 * The dedupe key convention is `${campaign}:${user_id}`, enforced by a partial
 * unique index. A STABLE slug is what makes a retry safe: re-sending the same
 * chunk comes back as `deduped`, not duplicated. Timestamps or randomness in
 * the slug defeat the entire mechanism, so the charset excludes `:` (which
 * would make the key ambiguous) and any whitespace.
 */
const CAMPAIGN_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateCampaignSlug(slug: string): string | null {
  const trimmed = slug.trim();
  if (!trimmed) return "Campaign slug is required — it's what makes a retry safe";
  if (!CAMPAIGN_SLUG_RE.test(trimmed)) {
    return "Campaign slug must be lowercase letters, digits, dot, dash or underscore (no spaces, no colon)";
  }
  if (trimmed.length > 100) return "Campaign slug must be 100 characters or less";
  return null;
}

export function dedupeKeyFor(campaign: string, userId: string): string {
  return `${campaign.trim()}:${userId}`;
}

// ── Recipient parsing ───────────────────────────────────────────────────

export type RecipientDraft = {
  userId: string;
  /** Per-recipient payload. Merged over the shared payload at build time. */
  payload?: NotificationPayload;
};

export type RecipientParse =
  | {
      ok: true;
      recipients: RecipientDraft[];
      format: "json" | "csv" | "ids";
      /** Ids that appear more than once. They are kept (the second one comes
       * back as `deduped`), but the operator should know — `unknown_users` is
       * de-duplicated server-side, so the counts won't sum to `requested`. */
      duplicateIds: string[];
      /** Pasted `dedupe_key` fields we ignored — dedupe is always derived from
       * the campaign slug so the retry guarantee can't be broken by accident. */
      ignoredDedupeKeys: number;
    }
  | { ok: false; error: string };

/** Reject ids that obviously aren't ids before spending a request on them. */
const ID_MAX = 128;

function normalizeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > ID_MAX || /\s/.test(id)) return null;
  return id;
}

/**
 * Split one CSV line, honouring RFC 4180 double-quoting so a payload value
 * may contain a comma (`"1,000 coins"`). Doubled quotes inside a quoted field
 * are an escaped quote.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** CSV cells are scalars — auto-typed so `value,25` sends a number, not "25". */
function coerceCsvValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

const USER_ID_HEADERS = new Set(["user_id", "userid", "id", "user"]);

/**
 * Accepts the three shapes an operator actually has to hand:
 *
 *   JSON  `[{ "user_id": "…", "payload": { "code": "…" } }]` (or bare id
 *         strings). Full control, including nested payloads.
 *   CSV   header row with a `user_id` column; EVERY other column becomes a
 *         payload key, values auto-typed. `user_id,code,value` is the
 *         promo-campaign shape.
 *   IDs   newline / comma separated ids, no header. Payload comes from the
 *         composer's shared-payload box.
 */
export function parseRecipients(text: string): RecipientParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste at least one recipient" };

  const recipients: RecipientDraft[] = [];
  let format: "json" | "csv" | "ids" = "ids";
  let ignoredDedupeKeys = 0;

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    format = "json";
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        error: `Recipient list isn't valid JSON — ${err instanceof Error ? err.message : "parse failed"}`,
      };
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row === "string") {
        const id = normalizeId(row);
        if (!id) return { ok: false, error: `Row ${i + 1}: "${row}" isn't a usable user id` };
        recipients.push({ userId: id });
        continue;
      }
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return { ok: false, error: `Row ${i + 1} must be an object or a user id string` };
      }
      const obj = row as Record<string, unknown>;
      const id = normalizeId(obj.user_id ?? obj.userId);
      if (!id) return { ok: false, error: `Row ${i + 1} is missing a usable "user_id"` };
      if (obj.dedupe_key !== undefined) ignoredDedupeKeys++;

      const rawPayload = obj.payload;
      if (rawPayload !== undefined && rawPayload !== null) {
        if (typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
          return { ok: false, error: `Row ${i + 1}: "payload" must be a JSON object` };
        }
        recipients.push({ userId: id, payload: rawPayload as NotificationPayload });
      } else {
        recipients.push({ userId: id });
      }
    }
  } else {
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));

    const headerCells = splitCsvLine(lines[0] ?? "");
    const idColumn = headerCells.findIndex((c) =>
      USER_ID_HEADERS.has(c.toLowerCase()),
    );

    if (idColumn !== -1 && headerCells.length >= 1) {
      format = "csv";
      const keys = headerCells.map((c, i) => (i === idColumn ? null : c));
      for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        const id = normalizeId(cells[idColumn]);
        if (!id) {
          return { ok: false, error: `Line ${i + 1}: missing or malformed user id` };
        }
        const payload: NotificationPayload = {};
        for (let c = 0; c < keys.length; c++) {
          const key = keys[c];
          const raw = cells[c];
          if (!key || raw === undefined || raw === "") continue;
          payload[key] = coerceCsvValue(raw);
        }
        recipients.push(
          Object.keys(payload).length > 0 ? { userId: id, payload } : { userId: id },
        );
      }
      if (recipients.length === 0) {
        return { ok: false, error: "The CSV has a header row but no data rows" };
      }
    } else {
      format = "ids";
      for (const line of lines) {
        for (const token of line.split(/[,\s]+/)) {
          if (!token) continue;
          const id = normalizeId(token);
          if (!id) return { ok: false, error: `"${token}" isn't a usable user id` };
          recipients.push({ userId: id });
        }
      }
    }
  }

  if (recipients.length === 0) {
    return { ok: false, error: "No recipients found in that list" };
  }

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const r of recipients) {
    if (seen.has(r.userId)) dupes.add(r.userId);
    seen.add(r.userId);
  }

  return {
    ok: true,
    recipients,
    format,
    duplicateIds: [...dupes],
    ignoredDedupeKeys,
  };
}

// ── Item building + chunking ────────────────────────────────────────────

export type BuildItemsResult =
  | { ok: true; items: BulkNotificationItem[] }
  | { ok: false; error: string };

/**
 * Turn parsed recipients into wire items: shared payload merged under each
 * per-recipient payload, dedupe key derived from the campaign slug. Every
 * item is validated here so a bad row fails BEFORE the first request goes
 * out — a 400 on chunk 12 of 17 is a terrible experience.
 */
export function buildBulkItems(
  recipients: RecipientDraft[],
  opts: { campaign: string; sharedPayload?: NotificationPayload },
): BuildItemsResult {
  const slugError = validateCampaignSlug(opts.campaign);
  if (slugError) return { ok: false, error: slugError };
  const campaign = opts.campaign.trim();

  const items: BulkNotificationItem[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const merged: NotificationPayload = {
      ...(opts.sharedPayload ?? {}),
      ...(r.payload ?? {}),
    };
    const check = validateNotificationPayload(merged);
    if (!check.ok) {
      return { ok: false, error: `${r.userId}: ${check.error}` };
    }
    const dedupeKey = dedupeKeyFor(campaign, r.userId);
    const keyError = validateDedupeKey(dedupeKey);
    if (keyError) {
      return {
        ok: false,
        error: `${r.userId}: ${keyError} — shorten the campaign slug`,
      };
    }
    items.push({
      user_id: r.userId,
      ...(check.payload ? { payload: check.payload } : {}),
      dedupe_key: dedupeKey,
    });
  }
  return { ok: true, items };
}

/**
 * Split items so no chunk exceeds EITHER cap. Both bind independently, so a
 * kilobyte-scale payload closes a chunk on bytes long before 1000 items.
 */
export function chunkBulkItems(
  items: BulkNotificationItem[],
  opts: { maxItems?: number; byteBudget?: number } = {},
): BulkNotificationItem[][] {
  const maxItems = opts.maxItems ?? BULK_MAX_ITEMS;
  const byteBudget = opts.byteBudget ?? BULK_BODY_BUDGET_BYTES;

  const chunks: BulkNotificationItem[][] = [];
  let current: BulkNotificationItem[] = [];
  let currentBytes = 0;

  for (const item of items) {
    // +1 for the separating comma in the serialized array.
    const size = jsonByteSize(item) + 1;
    if (
      current.length > 0 &&
      (current.length >= maxItems || currentBytes + size > byteBudget)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
