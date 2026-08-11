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
 * Unknown keys are STRIPPED by the backend's zod object. Besides the general
 * link/media fields, the contract includes validated challenge, pack-release,
 * and promo-card metadata.
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
  challenge_name?: string;
  game_type?: "pack" | "upgrader" | "keno";
  challenge_type?: "pack_pull" | "upgrader" | "keno";
  prize_usd?: string;
  pack_name?: string;
  price_usd?: string;
  packs?: Array<{
    name: string;
    price_usd: string;
    url: string;
    image_url?: string;
  }>;
  code?: string;
  value?: string;
};

export type AnnouncementPackPayloadDraft = {
  name: string;
  priceUsd: number;
  url: string;
  imageUrl: string | null;
};

/** Form-side shape used by the composer (camelCase). */
export type AnnouncementPayloadDraft = {
  url: string;
  imageUrl: string;
  ctaLabel: string;
  challengeName: string;
  challengeGame: "" | "pack" | "upgrader" | "keno";
  challengePrizeUsd: string;
  packs?: AnnouncementPackPayloadDraft[];
  promoCode?: string;
  promoValueUsd?: string;
};

export const EMPTY_PAYLOAD_DRAFT: AnnouncementPayloadDraft = {
  url: "",
  imageUrl: "",
  ctaLabel: "",
  challengeName: "",
  challengeGame: "",
  challengePrizeUsd: "",
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
  const challengeName = (draft?.challengeName ?? "").trim();
  const challengeGame = draft?.challengeGame ?? "";
  const challengePrizeUsd = (draft?.challengePrizeUsd ?? "").trim();
  const packDrafts = draft?.packs ?? [];
  const promoCode = (draft?.promoCode ?? "").trim().toUpperCase();
  const promoValueUsd = (draft?.promoValueUsd ?? "").trim();

  if (url) {
    if (!isHttpUrl(url)) {
      return {
        ok: false,
        error: "Link must be a full http:// or https:// URL",
      };
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
      return {
        ok: false,
        error: "Image URL is too long (max 2048 characters)",
      };
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
      error:
        "A button label needs a link to open — add a link or clear the label",
    };
  }

  const hasChallengeMetadata = Boolean(
    challengeName || challengeGame || challengePrizeUsd,
  );
  if (hasChallengeMetadata && (!challengeName || !challengeGame)) {
    return {
      ok: false,
      error: "Challenge announcements need both a name and game type",
    };
  }
  if (challengeName.length > 200) {
    return {
      ok: false,
      error: "Challenge name must be 200 characters or less",
    };
  }
  if (challengePrizeUsd) {
    const amount = Number(challengePrizeUsd.replace(/^\$/, ""));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
      return {
        ok: false,
        error: "Challenge prize must be between $0.01 and $100,000",
      };
    }
  }

  if (packDrafts.length > 3) {
    return { ok: false, error: "Pack announcements support up to 3 packs" };
  }
  const seenPackUrls = new Set<string>();
  const validatedPacks: NonNullable<AnnouncementPayload["packs"]> = [];
  for (const pack of packDrafts) {
    const name = pack.name.trim();
    const packUrl = pack.url.trim();
    const imageUrl = pack.imageUrl?.trim() ?? "";
    if (!name || name.length > 200) {
      return { ok: false, error: "Every pack needs a valid name" };
    }
    if (!isHttpUrl(packUrl) || packUrl.length > ANNOUNCEMENT_URL_MAX) {
      return { ok: false, error: `Pack ${name} needs a valid http(s) link` };
    }
    if (seenPackUrls.has(packUrl)) {
      return { ok: false, error: "The same pack cannot be selected twice" };
    }
    seenPackUrls.add(packUrl);
    if (imageUrl && !isImageKitUrl(imageUrl)) {
      return { ok: false, error: `Pack ${name} has an invalid image URL` };
    }
    if (
      !Number.isFinite(pack.priceUsd) ||
      pack.priceUsd < 0 ||
      pack.priceUsd > 100_000
    ) {
      return { ok: false, error: `Pack ${name} has an invalid price` };
    }
    validatedPacks.push({
      name,
      price_usd: pack.priceUsd.toFixed(2),
      url: packUrl,
      ...(imageUrl ? { image_url: imageUrl } : {}),
    });
  }

  if (promoCode.length > 256) {
    return { ok: false, error: "Promo code must be 256 characters or less" };
  }
  if (promoValueUsd) {
    const amount = Number(promoValueUsd.replace(/^\$/, ""));
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) {
      return {
        ok: false,
        error: "Promo value must be between $0 and $100,000",
      };
    }
  }

  if (
    !url &&
    !imageUrl &&
    !ctaLabel &&
    !hasChallengeMetadata &&
    validatedPacks.length === 0 &&
    !promoCode &&
    !promoValueUsd
  ) {
    return { ok: true, payload: undefined };
  }

  return {
    ok: true,
    payload: {
      ...(url ? { url } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(ctaLabel ? { cta_label: ctaLabel } : {}),
      ...(hasChallengeMetadata
        ? {
            challenge_name: challengeName,
            game_type: challengeGame as "pack" | "upgrader" | "keno",
            challenge_type: (challengeGame === "pack"
              ? "pack_pull"
              : challengeGame) as "pack_pull" | "upgrader" | "keno",
            ...(challengePrizeUsd
              ? {
                  prize_usd: Number(
                    challengePrizeUsd.replace(/^\$/, ""),
                  ).toFixed(2),
                }
              : {}),
          }
        : {}),
      ...(validatedPacks.length === 1
        ? {
            pack_name: validatedPacks[0].name,
            price_usd: validatedPacks[0].price_usd,
            url: validatedPacks[0].url,
            ...(validatedPacks[0].image_url
              ? { image_url: validatedPacks[0].image_url }
              : {}),
          }
        : validatedPacks.length > 1
          ? { packs: validatedPacks }
          : {}),
      ...(promoCode ? { code: promoCode } : {}),
      ...(promoValueUsd
        ? { value: Number(promoValueUsd.replace(/^\$/, "")).toFixed(2) }
        : {}),
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
