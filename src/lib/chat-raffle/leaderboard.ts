/** Shared deterministic ordering for live and frozen XP leaderboards. */
export type LeaderboardCandidate = {
  userId: string;
  points: number;
  scoreReachedAt: string | null;
};

export function compareLeaderboardCandidates(
  a: LeaderboardCandidate,
  b: LeaderboardCandidate,
): number {
  if (b.points !== a.points) return b.points - a.points;

  const aReached = a.scoreReachedAt
    ? new Date(a.scoreReachedAt).getTime()
    : Number.POSITIVE_INFINITY;
  const bReached = b.scoreReachedAt
    ? new Date(b.scoreReachedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (aReached !== bReached) return aReached - bReached;
  return a.userId.localeCompare(b.userId);
}

/** One distinct winner per configured prize place. */
export function selectLeaderboardWinners<T extends LeaderboardCandidate>(
  candidates: readonly T[],
  prizeCount: number,
): T[] {
  return candidates
    .slice()
    .sort(compareLeaderboardCandidates)
    .slice(0, Math.max(0, Math.trunc(prizeCount)));
}
