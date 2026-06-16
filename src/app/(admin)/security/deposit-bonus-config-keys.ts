/**
 * site_config keys owned by the deposit-bonus cap card on /security.
 *
 * This file is NOT a "use server" module — it only exports a plain
 * constant. Next.js rejects non-async exports from a "use server" file at
 * build time, which is why the value lives here (same pattern as
 * shard-config-keys.ts).
 *
 * The /security page filters these keys out of its generic site_config
 * table (the `movedKeys` Set) so the same row isn't editable in two
 * surfaces. The backend itself writes these keys via the admin API; the
 * panel never writes them directly — it goes through backendApi.put().
 *
 * Keys (managed by the backend's PUT /admin/deposit-bonus-config):
 *  - deposit_bonus_period_hours          rolling cap window length, in hours
 *  - deposit_bonus_cap_per_period_usd    max bonus USD per window
 */
export const DEPOSIT_BONUS_CONFIG_SITE_CONFIG_KEYS: readonly string[] = [
  "deposit_bonus_period_hours",
  "deposit_bonus_cap_per_period_usd",
];
