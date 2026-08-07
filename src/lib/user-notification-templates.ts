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
 *  1. `notificationText()` has cases for exactly three types. Its `default:`
 *     branch returns `{ title: "Notification", body: type.replace(/_/g," ") }`
 *     — so `promo_code_granted` renders as the literal words "promo code
 *     granted" with no code in sight.
 *  2. The popover builds personal rows WITHOUT an `href`. Only broadcast
 *     announcements read `payload.url`. So adding a link to a personal
 *     notification's payload does nothing today either.
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
