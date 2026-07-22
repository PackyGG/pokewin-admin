/**
 * Structured payload of a broadcast announcement — the "additional metadata"
 * the notification system carries next to title/body.
 *
 * MIRRORS the backend contract 1:1 (`AnnouncementPayloadSchema` in
 * packy-backend `src/schemas/websocket.ts`, consumed by
 * `POST /v1/admin/announcements`):
 *
 *   url        optional, http(s) only, ≤ 2048 chars
 *   image_url  optional, ImageKit only (https://ik.imagekit.io/scrkflpgw/…),
 *              ≤ 2048 chars — the frontend's next/image host allowlist only
 *              whitelists that endpoint, so any other host is rejected at
 *              compose time rather than silently failing to render
 *   cta_label  optional, ≤ 60 chars
 *
 * Unknown keys are STRIPPED by the backend's zod object, so a field that is
 * not one of these three never reaches the client — do not invent extra keys
 * here (a `promo_code` key, for example, would be dropped on the way in).
 *
 * Validating admin-side keeps a bad value inside the dialog with a usable
 * message instead of surfacing as an opaque 422 from the backend. Both the
 * client composer and the server action run this same function.
 */

export const IMAGEKIT_URL_PREFIX = "https://ik.imagekit.io/scrkflpgw/";
export const ANNOUNCEMENT_URL_MAX = 2048;
export const ANNOUNCEMENT_CTA_MAX = 60;
export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_BODY_MAX = 4000;
export const ANNOUNCEMENT_TYPE_MAX = 64;

/** Wire shape sent to the backend (snake_case, as the API expects). */
export type AnnouncementPayload = {
  url?: string | null;
  image_url?: string | null;
  cta_label?: string | null;
};

/** Form-side shape used by the composer (camelCase, always strings). */
export type AnnouncementPayloadDraft = {
  url: string;
  imageUrl: string;
  ctaLabel: string;
};

export const EMPTY_PAYLOAD_DRAFT: AnnouncementPayloadDraft = {
  url: "",
  imageUrl: "",
  ctaLabel: "",
};

/** http(s) only — blocks javascript:/data: schemes, same as the backend. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** The frontend can only render images served from our ImageKit endpoint. */
export function isImageKitUrl(value: string): boolean {
  return value.startsWith(IMAGEKIT_URL_PREFIX) && isHttpUrl(value);
}

export type PayloadValidation =
  | { ok: true; payload: AnnouncementPayload | undefined }
  | { ok: false; error: string };

/**
 * Trims the draft, drops empty fields and rejects anything the backend would
 * reject. Returns `undefined` when nothing is set, so a plain text-only
 * announcement sends no `payload` key at all (backend default `{}`).
 */
export function validateAnnouncementPayload(
  draft: Partial<AnnouncementPayloadDraft> | undefined,
): PayloadValidation {
  const url = (draft?.url ?? "").trim();
  const imageUrl = (draft?.imageUrl ?? "").trim();
  const ctaLabel = (draft?.ctaLabel ?? "").trim();

  if (url) {
    if (!isHttpUrl(url)) {
      return { ok: false, error: "Link must be a full http:// or https:// URL" };
    }
    if (url.length > ANNOUNCEMENT_URL_MAX) {
      return { ok: false, error: "Link is too long (max 2048 characters)" };
    }
  }

  if (imageUrl) {
    if (!isImageKitUrl(imageUrl)) {
      return {
        ok: false,
        error: `Image must be an ImageKit URL (${IMAGEKIT_URL_PREFIX}…) — upload the image here to get one`,
      };
    }
    if (imageUrl.length > ANNOUNCEMENT_URL_MAX) {
      return { ok: false, error: "Image URL is too long (max 2048 characters)" };
    }
  }

  if (ctaLabel.length > ANNOUNCEMENT_CTA_MAX) {
    return {
      ok: false,
      error: `Button label must be ${ANNOUNCEMENT_CTA_MAX} characters or less`,
    };
  }
  if (ctaLabel && !url) {
    return {
      ok: false,
      error: "A button label needs a link to open — add a link or clear the label",
    };
  }

  if (!url && !imageUrl && !ctaLabel) return { ok: true, payload: undefined };

  return {
    ok: true,
    payload: {
      ...(url ? { url } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(ctaLabel ? { cta_label: ctaLabel } : {}),
    },
  };
}

/** Compact "packy.gg/games/packs/x" label for a stored announcement link. */
export function shortUrlLabel(value: string): string {
  try {
    const u = new URL(value);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return value;
  }
}
