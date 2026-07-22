/**
 * site_config keys owned by the Telegram notifications card on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * deposit-bonus-config-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/telegram-notifications):
 *  - telegram_deposit_min_usd                minimum deposit USD that alerts
 *  - telegram_signup_notifications_enabled   send an alert on each signup
 */
export const TELEGRAM_NOTIFICATION_SITE_CONFIG_KEYS: readonly string[] = [
  "telegram_deposit_min_usd",
  "telegram_signup_notifications_enabled",
];
