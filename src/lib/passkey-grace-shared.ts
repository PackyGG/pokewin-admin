import { MS_PER_MINUTE } from "@/lib/utils/time";

/** Client/server marker submitted to require2FA while the signed grace cookie is active. */
export const PASSKEY_GRACE_CREDENTIAL = "__admin_passkey_grace__";

/** Admins and owners may reuse a successful passkey assertion for ten minutes. */
export const PASSKEY_GRACE_TTL_MS = 10 * MS_PER_MINUTE;
