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
 *  - telegram_notifications_enabled            master switch for all alerts
 *  - telegram_deposit_min_usd                  minimum deposit USD that alerts
 *  - telegram_notify_<kind>                    per-notification on/off
 *  - telegram_signup_notifications_enabled     signup alerts (original key —
 *      deliberately NOT renamed to telegram_notify_signup, so an already-saved
 *      value isn't orphaned)
 */
export const TELEGRAM_NOTIFICATION_SITE_CONFIG_KEYS: readonly string[] = [
  "telegram_notifications_enabled",
  "telegram_deposit_min_usd",
  "telegram_notify_deposit_confirmed",
  "telegram_notify_deposit_failed",
  "telegram_notify_withdrawal_requested",
  "telegram_notify_withdrawal_completed",
  "telegram_notify_withdrawal_failed",
  "telegram_signup_notifications_enabled",
];
