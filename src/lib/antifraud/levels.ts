import type { AccentColor } from "@/components/modern-panels";

/**
 * The staff level ladder.
 *
 * Points are earned one per correct quiz answer (plus whatever the owner awards
 * manually), so the thresholds are deliberately SMALL — a level has to be
 * reachable by answering questions, not by grinding four figures. The ladder is
 * a pure constant rather than a DB table on purpose: a level is a derived view
 * of `staff_profiles.points_total`, and keeping the mapping in code means it is
 * deterministic, diffable, and can never disagree between two requests.
 *
 * Changing a threshold retroactively re-levels everyone (their points don't
 * move, only the label). That is intended — the ladder is a presentation layer.
 */
export type StaffLevel = {
  /** 1-based level number, matches `staff_profiles.level`. */
  level: number;
  /** Points required to REACH this level. */
  minPoints: number;
  title: string;
  accent: AccentColor;
};

export const STAFF_LEVELS: readonly StaffLevel[] = [
  { level: 1, minPoints: 0, title: "Trainee", accent: "blue" },
  { level: 2, minPoints: 10, title: "Rookie", accent: "blue" },
  { level: 3, minPoints: 25, title: "Agent", accent: "cyan" },
  { level: 4, minPoints: 50, title: "Analyst", accent: "cyan" },
  { level: 5, minPoints: 90, title: "Investigator", accent: "emerald" },
  { level: 6, minPoints: 140, title: "Specialist", accent: "emerald" },
  { level: 7, minPoints: 200, title: "Senior Analyst", accent: "amber" },
  { level: 8, minPoints: 275, title: "Lead", accent: "amber" },
  { level: 9, minPoints: 365, title: "Elite", accent: "purple" },
  { level: 10, minPoints: 500, title: "Sentinel", accent: "purple" },
] as const;

/** The highest level anyone can reach. */
export const MAX_STAFF_LEVEL = STAFF_LEVELS[STAFF_LEVELS.length - 1].level;

/**
 * The level a given point total resolves to. Clamps negatives to level 1 (a
 * correction can push someone below zero; they stay a Trainee rather than
 * falling off the ladder).
 */
export function levelForPoints(points: number): StaffLevel {
  const p = Number.isFinite(points) ? points : 0;
  let current = STAFF_LEVELS[0];
  for (const entry of STAFF_LEVELS) {
    if (p >= entry.minPoints) current = entry;
    else break;
  }
  return current;
}

/** The level entry for a stored level number (defensive against bad data). */
export function levelInfo(level: number): StaffLevel {
  return (
    STAFF_LEVELS.find((entry) => entry.level === level) ?? STAFF_LEVELS[0]
  );
}

/**
 * Progress of a point total INSIDE its current level — for the profile bar.
 * At max level `next` is null and `percent` pins to 100 so the bar reads
 * "complete" rather than empty.
 */
export function levelProgress(points: number): {
  current: StaffLevel;
  next: StaffLevel | null;
  /** Points earned inside the current band. */
  intoLevel: number;
  /** Points the current band spans (0 at max level). */
  bandSize: number;
  /** Points still needed for the next level (0 at max level). */
  remaining: number;
  /** 0–100. */
  percent: number;
} {
  const p = Number.isFinite(points) ? Math.max(0, points) : 0;
  const current = levelForPoints(p);
  const next =
    STAFF_LEVELS.find((entry) => entry.level === current.level + 1) ?? null;

  if (!next) {
    return {
      current,
      next: null,
      intoLevel: p - current.minPoints,
      bandSize: 0,
      remaining: 0,
      percent: 100,
    };
  }

  const bandSize = next.minPoints - current.minPoints;
  const intoLevel = p - current.minPoints;
  return {
    current,
    next,
    intoLevel,
    bandSize,
    remaining: Math.max(0, next.minPoints - p),
    percent:
      bandSize <= 0 ? 100 : Math.min(100, Math.round((intoLevel / bandSize) * 100)),
  };
}
