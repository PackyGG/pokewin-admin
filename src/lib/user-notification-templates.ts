/**
 * What a personal notification ACTUALLY looks like in the user's feed.
 *
 * `type` is an i18n key, not display copy — the site maps it to a template
 * and renders that. If the site has no case for the key you send, the user
 * sees a generic fallback and your `payload` is never shown. That is not a
 * backend failure: the row is written, the API returns the payload, the
 * client simply has nothing to render it with.
 *
 * MIRRORS the frontend, verified 2026-07-22 against
 *   packy-frontend `src/components/navigation/notification-text.ts`
 *   packy-frontend `src/components/navigation/notification-popover.tsx`
 *
 * Two facts from that code drive everything below:
 *
 *  1. `notificationText()` has an explicit allowlist of types. Its `default:`
 *     branch returns `{ title: "Notification", body: type.replace(/_/g," ") }`
 *     — so `promo_code_granted` renders as the literal words "promo code
 *     granted" with no code in sight.
 *  2. The popover only turns validated `payload.url` / `payload.image_url`
 *     into a linked image row. Other payload keys need an explicit template.
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
  href?: string;
  /** False when the site falls back to the generic template. */
  known: boolean;
  /** Payload keys the site's template actually reads for this type. */
  usedKeys: string[];
};

/** Types the site renders with real copy, and the payload keys each reads. */
export const KNOWN_NOTIFICATION_TYPES: Record<string, string[]> = {
  deposit_pending: ["amount_usd"],
  deposit_completed: ["amount_usd"],
  reward_credited: ["amount_usd"],
  promo_code_granted: ["code", "value", "amount_usd"],
  pack_release: ["pack_name", "price_usd", "url", "image_url", "packs"],
};

/** Mirrors the frontend's `formatUsd` — tolerant of number-or-string because
 * admin payloads are typed by hand (CSV column vs JSON body). */
function formatUsd(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value % 1 === 0 ? value : value.toFixed(2)}`;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
  }
  return "";
}

type PreviewPack = {
  name: string;
  price?: number;
  image?: string;
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
  };
}

export function previewNotificationText(
  type: string,
  payload: Record<string, unknown> | undefined,
): NotificationPreview {
  const key = type.trim();
  const amountUsd =
    typeof payload?.amount_usd === "string" ? `$${payload.amount_usd}` : "";
  const ofAmount = amountUsd ? ` of ${amountUsd}` : "";

  switch (key) {
    case "deposit_pending":
      return {
        title: "Deposit detected",
        body: `Your deposit${ofAmount} is awaiting confirmation.`,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.deposit_pending,
      };
    case "deposit_completed":
      return {
        title: "Deposit completed",
        body: `Your deposit${ofAmount} is now available.`,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.deposit_completed,
      };
    case "reward_credited":
      return {
        title: "Reward credited",
        body: `You received a reward${ofAmount}.`,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.reward_credited,
      };
    case "promo_code_granted": {
      // Shipped in PackyGG/frontend#749 — the code renders as a chip the user
      // taps to copy, and the realtime toast carries its own Copy action.
      const code =
        typeof payload?.code === "string" && payload.code.trim() !== ""
          ? payload.code.trim()
          : undefined;
      const worth = formatUsd(payload?.value ?? payload?.amount_usd);
      return {
        title: worth ? `${worth} promo code for you` : "Promo code for you",
        body: "Redeem it in your wallet.",
        code,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.promo_code_granted,
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
        body: price ? `${price} per open` : "Tap to view it.",
        image:
          arrayPack?.image ??
          (typeof payload?.image_url === "string"
            ? payload.image_url
            : undefined),
        href: typeof payload?.url === "string" ? payload.url : undefined,
        known: true,
        usedKeys: KNOWN_NOTIFICATION_TYPES.pack_release,
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
