/**
 * What a personal notification ACTUALLY looks like in the user's feed.
 *
 * `type` is an i18n key, not display copy — the site maps it to a template
 * and renders that. If the site has no case for the key you send, the user
 * sees a generic fallback and your `payload` is never shown. That is not a
 * backend failure: the row is written, the API returns the payload, the
 * client simply has nothing to render it with.
 *
 * MIRRORS the frontend notification presentation contract. Recognized types
 * derive their copy and specialized card metadata from the payload; unknown
 * types fall back to a generic title/body and ignore unrecognized metadata.
 *
 * This module exists so the composer can show the operator that truth up
 * front instead of letting them discover it by sending to a real account.
 *
 * DRIFT: this is a copy of code in another repo. When the frontend learns a
 * new type, add it here too — a stale entry here only ever produces an
 * over-cautious warning, never a wrong send.
 */

export type NotificationPreview = {
  title: string;
  body: string;
  /** Rendered by the site as a monospace copy-to-clipboard chip. */
  code?: string;
  image?: string;
  images?: string[];
  packCount?: number;
  challengeGame?: "keno" | "upgrader" | "pack";
  href?: string;
  /** False when the site falls back to the generic template. */
  known: boolean;
  /** Payload keys the site's template actually reads for this type. */
  usedKeys: string[];
};

/** Types the site renders with real copy, and the payload keys each reads. */
export const KNOWN_NOTIFICATION_TYPES: Record<string, string[]> = {
  deposit_pending: ["amount_usd"],
  deposit_review: ["amount_usd"],
  deposit_completed: ["amount_usd"],
  tip_received: ["sender_username", "amount_usd"],
  promo_code_granted: ["code", "value", "amount_usd"],
  leaderboard_ending_soon: [
    "race_type",
    "is_participant",
    "position",
    "prize_usd",
    "prize_pool_usd",
    "ends_at",
    "url",
  ],
  pack_release: ["pack_name", "price_usd", "url", "image_url", "packs"],
  admin_message: ["title", "body"],
  challenge_available: [
    "challenge_id",
    "challenge_name",
    "game_type",
    "challenge_type",
    "prize_usd",
    "url",
  ],
};

/** Mirrors the frontend's `formatUsd` — tolerant of number-or-string because
 * admin payloads are typed by hand (CSV column vs JSON body). */
function formatUsd(value: unknown): string {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim().replace(/^\$/, ""))
        : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? `$${amount.toFixed(2)}` : "";
}

type PreviewPack = {
  name: string;
  price?: number;
  image?: string;
  href?: string;
};

function previewPack(value: unknown): PreviewPack | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const pack = value as Record<string, unknown>;
  if (typeof pack.name !== "string" || !pack.name.trim()) return;
  const numericPrice =
    typeof pack.price_usd === "number"
      ? pack.price_usd
      : typeof pack.price_usd === "string"
        ? Number(pack.price_usd.replace(/^\$/, ""))
        : Number.NaN;
  return {
    name: pack.name.trim(),
    price: Number.isFinite(numericPrice) ? numericPrice : undefined,
    image: typeof pack.image_url === "string" ? pack.image_url : undefined,
    href: typeof pack.url === "string" ? pack.url : undefined,
  };
}

export function previewNotificationText(
  type: string,
  payload: Record<string, unknown> | undefined,
): NotificationPreview {
  const key = type.trim();
  const amountUsd = formatUsd(payload?.amount_usd);

  switch (key) {
    case "admin_message":
      return {
        title:
          typeof payload?.title === "string" && payload.title.trim()
            ? payload.title.trim()
            : "Message",
        body:
          typeof payload?.body === "string" && payload.body.trim()
            ? payload.body.trim()
            : "You have a new message.",
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.admin_message,
      };
    case "deposit_pending":
      return {
        title: "Deposit detected",
        body: amountUsd
          ? `${amountUsd} is awaiting network confirmation.`
          : "Awaiting network confirmation.",
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.deposit_pending,
      };
    case "deposit_review":
      return {
        title: "Your deposit is in review",
        body: amountUsd
          ? `${amountUsd} is awaiting manual approval. We’ll notify you when it’s credited.`
          : "Your deposit is awaiting manual approval. We’ll notify you when it’s credited.",
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.deposit_review,
      };
    case "deposit_completed":
      return {
        title: "Deposit completed",
        body: amountUsd
          ? `${amountUsd} is available in your balance.`
          : "Available in your balance.",
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.deposit_completed,
      };
    case "tip_received": {
      const sender =
        typeof payload?.sender_username === "string" &&
        payload.sender_username.trim()
          ? payload.sender_username.trim()
          : "Someone";
      return {
        title: `From ${sender}`,
        body: amountUsd
          ? `${amountUsd} added to your balance.`
          : "A tip was added to your balance.",
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.tip_received,
      };
    }
    case "promo_code_granted": {
      const code =
        typeof payload?.code === "string" && payload.code.trim() !== ""
          ? payload.code.trim()
          : undefined;
      const worth = formatUsd(payload?.value ?? payload?.amount_usd);
      return {
        title: worth ? `${worth} promo unlocked` : "Promo unlocked",
        body: "Redeem it now.",
        code,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.promo_code_granted,
      };
    }
    case "leaderboard_ending_soon": {
      const raceType = payload?.race_type === "monthly" ? "monthly" : "weekly";
      const participant = payload?.is_participant === true;
      const positionValue = Number(payload?.position);
      const position =
        participant && Number.isInteger(positionValue) && positionValue > 0
          ? positionValue
          : undefined;
      const prize = formatUsd(payload?.prize_usd);
      const prizePool = formatUsd(payload?.prize_pool_usd);
      const label = raceType === "monthly" ? "Monthly" : "Weekly";
      return {
        title: participant && position ? `You’re #${position}` : `${label} race is closing`,
        body: participant
          ? prize
            ? `Currently holding a ${prize} prize.`
            : "Make a final push before the standings lock."
          : prizePool
            ? `${prizePool} prize pool. There’s still time to enter.`
            : "There’s still time to enter the race.",
        href:
          typeof payload?.url === "string"
            ? payload.url
            : `/races?type=${raceType}`,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.leaderboard_ending_soon,
      };
    }
    case "pack_release": {
      const packs = Array.isArray(payload?.packs)
        ? payload.packs.slice(0, 3).map(previewPack).filter(Boolean)
        : [];
      if (packs.length >= 2) {
        const prices = packs
          .map((pack) => pack?.price)
          .filter((price): price is number => price !== undefined);
        const lowestPrice = prices.length > 0 ? Math.min(...prices) : undefined;
        return {
          title: "Fresh packs just dropped",
          body:
            lowestPrice === undefined
              ? "See what’s new"
              : `Starting at ${formatUsd(lowestPrice)} per open`,
          images: packs
            .map((pack) => pack?.image)
            .filter((image): image is string => image !== undefined),
          packCount: packs.length,
          href: typeof payload?.url === "string" ? payload.url : undefined,
          known: true,
          usedKeys: KNOWN_NOTIFICATION_TYPES.pack_release,
        };
      }

      const arrayPack = packs[0];
      const packName =
        arrayPack?.name ??
        (typeof payload?.pack_name === "string" && payload.pack_name.trim()
          ? payload.pack_name.trim()
          : "A new pack");
      const price = formatUsd(arrayPack?.price ?? payload?.price_usd);
      return {
        title: packName,
        body: price ? `${price} per open` : "Available now",
        image:
          arrayPack?.image ??
          (typeof payload?.image_url === "string"
            ? payload.image_url
            : undefined),
        href:
          arrayPack?.href ??
          (typeof payload?.url === "string" ? payload.url : undefined),
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.pack_release,
      };
    }
    case "challenge_available": {
      const challengeGame =
        payload?.game_type === "keno" ||
        payload?.game_type === "upgrader" ||
        payload?.game_type === "pack"
          ? payload.game_type
          : payload?.challenge_type === "pack_pull"
            ? "pack"
            : undefined;
      const name =
        typeof payload?.challenge_name === "string" &&
        payload.challenge_name.trim()
          ? payload.challenge_name.trim()
          : "New challenge";
      const prize = formatUsd(payload?.prize_usd);
      const challengeLabel =
        challengeGame === "keno"
          ? "Keno"
          : challengeGame === "upgrader"
            ? "Upgrader"
            : challengeGame === "pack"
              ? "Pack Pull"
              : undefined;
      return {
        title: `${name} is live`,
        body: challengeLabel
          ? prize
            ? `Complete this ${challengeLabel} challenge to claim ${prize}.`
            : `A new ${challengeLabel} challenge is ready to play.`
          : prize
            ? `Complete this challenge to claim ${prize}.`
            : "A new challenge is ready to play.",
        href:
          typeof payload?.url === "string"
            ? payload.url
            : "/rewards?tab=challenges",
        challengeGame,
        known: challengeGame !== undefined,
        usedKeys: KNOWN_NOTIFICATION_TYPES.challenge_available,
      };
    }
    default:
      return {
        title: "Notification",
        body: key.replace(/_/g, " "),
        known: false,
        usedKeys: [],
      };
  }
}

/** Payload keys that will be delivered but never rendered for this type. */
export function unrenderedPayloadKeys(
  type: string,
  payload: Record<string, unknown> | undefined,
): string[] {
  if (!payload) return [];
  const used = new Set(previewNotificationText(type, payload).usedKeys);
  return Object.keys(payload).filter((k) => !used.has(k));
}
