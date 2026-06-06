import "server-only";

import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { getAdminSetting, setAdminSetting } from "@/lib/admin-settings";

/**
 * Third-party integration API-key storage (security-sensitive, SERVER-ONLY).
 *
 * The Creator Hub pulls per-creator Kick + Twitter/X data from RapidAPI
 * (plan: iridescent-mixing-lecun.md → "External data integrations"). Per the
 * owner's spec the keys are NOT env vars — they're persisted in the ADMIN DB
 * `admin_settings` key/value table and edited from a Creator-Hub Settings
 * page. RapidAPI keys are **secrets**: the API calls run server-side, so the
 * raw key must never reach the browser / a client payload.
 *
 * This module is the single source of truth for those keys. It is marked
 * `server-only` so importing it from a Client Component is a build error —
 * the raw `getIntegrationApiKey()` value can only ever be read on the server.
 * The UI consumes {@link getIntegrationKeyStatuses}, which returns nothing
 * but a masked preview + set/unset + last-updated metadata.
 */

/**
 * `admin_settings` keys that hold the RapidAPI secrets. Stored under the
 * `integration_` namespace so they're visually distinct from the other
 * key/value settings. Concrete keys requested by the owner spec:
 *   • integration_kick_rapidapi_key    — RapidAPI key for kick-com-api (Bukk)
 *   • integration_twitter_rapidapi_key — RapidAPI key for twitter241
 */
export const INTEGRATION_KEYS = {
  KICK_RAPIDAPI: "integration_kick_rapidapi_key",
  TWITTER_RAPIDAPI: "integration_twitter_rapidapi_key",
} as const;

/** Stable id for each managed integration key (used by the form + action). */
export type IntegrationKeyId = "kick" | "twitter";

/** Maps the public key id → the concrete `admin_settings` key string. */
const SETTINGS_KEY_BY_ID: Record<IntegrationKeyId, string> = {
  kick: INTEGRATION_KEYS.KICK_RAPIDAPI,
  twitter: INTEGRATION_KEYS.TWITTER_RAPIDAPI,
};

/** Display metadata for each managed key (label/provider/host) — UI-safe. */
export const INTEGRATION_KEY_META: Record<
  IntegrationKeyId,
  { label: string; provider: string; host: string }
> = {
  kick: {
    label: "Kick API key",
    provider: "RapidAPI · kick-com-api (Bukk)",
    host: "kick-com-api.p.rapidapi.com",
  },
  twitter: {
    label: "Twitter / X API key",
    provider: "RapidAPI · twitter241",
    host: "twitter241.p.rapidapi.com",
  },
};

export const INTEGRATION_KEY_IDS: readonly IntegrationKeyId[] = [
  "kick",
  "twitter",
] as const;

function isIntegrationKeyId(value: string): value is IntegrationKeyId {
  return (INTEGRATION_KEY_IDS as readonly string[]).includes(value);
}

/**
 * Validation for a submitted key. A RapidAPI key is a longish opaque token;
 * we only enforce a sane non-empty length bound and trim surrounding
 * whitespace. An empty string is rejected here — clearing a key has its own
 * explicit path ({@link clearIntegrationKey}) so an accidental blank submit
 * can never silently wipe a configured secret.
 */
export const integrationKeyInputSchema = z.object({
  id: z
    .string()
    .refine(isIntegrationKeyId, { message: "Unknown integration key." }),
  value: z
    .string()
    .trim()
    .min(8, { message: "That key looks too short to be valid." })
    .max(40000, { message: "That key is too long." }),
});

export type IntegrationKeyInput = z.infer<typeof integrationKeyInputSchema>;

/**
 * Client-safe status for one integration key. **Never** carries the raw
 * secret — only whether it's set, a short masked preview (last 4 chars), and
 * when/by whom it was last changed. This is the only shape the Settings UI
 * ever receives.
 */
export type IntegrationKeyStatus = {
  id: IntegrationKeyId;
  label: string;
  provider: string;
  host: string;
  isSet: boolean;
  /** e.g. "••••••••3f2a" — last 4 chars only; empty when unset. */
  maskedPreview: string;
  /** ISO timestamp of the last write, or null when never set. */
  lastUpdated: string | null;
  /** admin_users.id of the last editor, or null. UI maps to a name. */
  updatedBy: string | null;
};

/**
 * Build a masked preview that reveals only the final 4 characters of a key,
 * so an operator can sanity-check WHICH key is stored without the secret
 * being recoverable. Short keys are fully masked.
 */
function maskKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const visible = trimmed.length > 8 ? trimmed.slice(-4) : "";
  return "•".repeat(8) + visible;
}

/**
 * Load the masked status of every managed integration key. SERVER-ONLY.
 *
 * Reads each value through {@link getAdminSetting} (which degrades a missing
 * `admin_settings` table to `null`), derives the masked preview in-process,
 * and discards the raw value before returning — the caller only ever sees
 * metadata. The `updated_at` / `updated_by` columns come from a direct
 * metadata read on the row (value column intentionally not selected).
 */
export async function getIntegrationKeyStatuses(): Promise<
  IntegrationKeyStatus[]
> {
  return Promise.all(
    INTEGRATION_KEY_IDS.map(async (id): Promise<IntegrationKeyStatus> => {
      const settingsKey = SETTINGS_KEY_BY_ID[id];
      const meta = INTEGRATION_KEY_META[id];

      const value = await getAdminSetting(settingsKey);
      const isSet = typeof value === "string" && value.trim().length > 0;

      // Metadata-only read (no `value` selected) for the audit fields. Best
      // effort: a missing table or transient fault leaves these null and the
      // status still renders.
      let lastUpdated: string | null = null;
      let updatedBy: string | null = null;
      if (isSet) {
        try {
          const row = await adminDb.admin_settings.findUnique({
            where: { key: settingsKey },
            select: { updated_at: true, updated_by: true },
          });
          lastUpdated = row?.updated_at ? row.updated_at.toISOString() : null;
          updatedBy = row?.updated_by ?? null;
        } catch {
          // leave audit fields null — never block the status on this read.
        }
      }

      return {
        id,
        label: meta.label,
        provider: meta.provider,
        host: meta.host,
        isSet,
        maskedPreview: isSet ? maskKey(value as string) : "",
        lastUpdated,
        updatedBy,
      };
    }),
  );
}

/**
 * Client-safe row for the Settings UI: the masked status with the last
 * editor resolved to a DISPLAY NAME (never the raw `updated_by` UUID). This
 * is the exact shape passed across the RSC boundary to the form — no secret,
 * no internal id. Both the page and the server action return this shape so
 * they can't drift.
 */
export type IntegrationKeyRowData = {
  id: IntegrationKeyId;
  label: string;
  provider: string;
  host: string;
  isSet: boolean;
  maskedPreview: string;
  lastUpdated: string | null;
  /** Display name of the last editor, or null. Never a raw UUID. */
  updatedByName: string | null;
};

/**
 * Load the client-safe integration key rows: masked statuses + the last
 * editor resolved to a display name. SERVER-ONLY. Resolves the distinct
 * `updated_by` ids in one ADMIN-DB read and maps them to
 * `display_username ?? username`, so the UI shows a person rather than a
 * UUID. The raw secret is never part of the result.
 */
export async function getIntegrationKeyRows(): Promise<IntegrationKeyRowData[]> {
  const statuses = await getIntegrationKeyStatuses();

  const editorIds = Array.from(
    new Set(
      statuses
        .map((s) => s.updatedBy)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const editorNames = new Map<string, string>();
  if (editorIds.length > 0) {
    try {
      const editors = await adminDb.admin_users.findMany({
        where: { id: { in: editorIds } },
        select: { id: true, username: true, display_username: true },
      });
      for (const e of editors) {
        editorNames.set(e.id, e.display_username ?? e.username);
      }
    } catch {
      // best effort — leave names unresolved on a transient read fault.
    }
  }

  return statuses.map((s) => ({
    id: s.id,
    label: s.label,
    provider: s.provider,
    host: s.host,
    isSet: s.isSet,
    maskedPreview: s.maskedPreview,
    lastUpdated: s.lastUpdated,
    updatedByName: s.updatedBy ? (editorNames.get(s.updatedBy) ?? null) : null,
  }));
}

/**
 * Persist one integration key (raw secret → ADMIN DB). SERVER-ONLY. The
 * value is stored verbatim via {@link setAdminSetting} (which stamps
 * `updated_by` + `updated_at`). Callers MUST authorize before invoking — this
 * function performs no access check of its own.
 */
export async function setIntegrationKey(
  id: IntegrationKeyId,
  value: string,
  adminUserId: string,
): Promise<void> {
  await setAdminSetting(SETTINGS_KEY_BY_ID[id], value, adminUserId);
}

/**
 * Clear a stored integration key (sets it to the empty string, so
 * {@link getIntegrationKeyStatuses} reports it unset). SERVER-ONLY; callers
 * MUST authorize first.
 */
export async function clearIntegrationKey(
  id: IntegrationKeyId,
  adminUserId: string,
): Promise<void> {
  await setAdminSetting(SETTINGS_KEY_BY_ID[id], "", adminUserId);
}

/**
 * Read the raw integration secret for use in a server-side API call.
 * SERVER-ONLY — the `server-only` import at the top of this module makes
 * pulling this into a Client Component a build error. Returns `null` when the
 * key is unset (callers should degrade gracefully / surface "not configured"
 * rather than calling the third-party API with an empty key).
 */
export async function getIntegrationApiKey(
  id: IntegrationKeyId,
): Promise<string | null> {
  const value = await getAdminSetting(SETTINGS_KEY_BY_ID[id]);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
