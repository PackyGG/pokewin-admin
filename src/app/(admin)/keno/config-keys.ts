/**
 * Keno-owned site_config keys.
 *
 * The generic /security table filters these out so the live bet and win caps
 * have exactly one editable surface: Content -> Keno -> Configuration.
 * Writes go through the backend admin API rather than directly to MAIN.
 */
export const KENO_SITE_CONFIG_KEYS: readonly string[] = [
  "keno_max_bet_usd",
  "keno_max_win_usd",
];
