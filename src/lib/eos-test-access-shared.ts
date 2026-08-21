/**
 * Exact EOS testing allowlist shared by the server-side route guard and the
 * client-rendered sidebar. Keep this module dependency-free so nav-config can
 * safely import it in both environments.
 */
export const EOS_TEST_USERNAMES = ["motha", "hifoen"] as const;
