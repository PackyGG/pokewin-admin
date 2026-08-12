const INTERNAL_BATTLE_TESTING_USERNAMES = new Set([
  "hifoen",
  "motha",
  "zog",
]);

export function canManageTestingBattleOutcomes(
  username: string | null | undefined,
): boolean {
  return INTERNAL_BATTLE_TESTING_USERNAMES.has(
    (username ?? "").trim().toLowerCase(),
  );
}
