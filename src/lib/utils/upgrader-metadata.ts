/**
 * Upgrader play metadata parser.
 *
 * The per-game configuration the user picked before each upgrader spin
 * (target multiplier, target win chance, roll outcome) is stored in the
 * `provably_fair_results.result_metadata` JSON blob — there is NO typed
 * column for these fields on `upgrader_games` (which only carries
 * `id`, `user_id`, `bet_amount`, `won_amount`, `created_at`).
 *
 * The blob shape isn't pinned in code anywhere in this repo: existing
 * readers only ever pull `borrow_percentage` out of it (see
 * `lib/queries/users-transactions.ts`). The backend isn't on this
 * worktree, so we read DEFENSIVELY — trying a handful of plausible
 * key names and accepting either numbers or stringified numbers.
 *
 * Everything is best-effort: if a key isn't present the corresponding
 * field returns `null` and the UI renders "—". The raw blob is still
 * surfaced separately by the dialog so any field this parser misses
 * remains visible for audit.
 *
 * Convention (when found):
 *   • targetMultiplier — the cashout multiplier the user was running
 *     at (e.g. 5 → "5×"). May be fractional (1.5, 2.5, ...).
 *   • targetChance     — explicit win-chance % if the backend stores
 *     it. Otherwise we derive it from targetMultiplier + houseEdge.
 *   • houseEdge        — site edge as a fraction (0.05 = 5%). Derived
 *     fallback when not present: 0 (no edge), so the derived chance
 *     becomes exactly 1/multiplier. Flagged so the UI can show "≈"
 *     when the derivation was used.
 *   • roll             — the random roll value the server produced.
 *     Format unknown without a backend reference (could be 0-1 float,
 *     0-100, 0-10000, ...) so we return it as a raw number and let the
 *     UI render it next to the threshold for context.
 *
 * The `winThreshold` helper computes the cutoff (player wins when
 * `roll < winThreshold` in the typical 0-1 / 0-100 / 0-10000 scheme),
 * given targetChance. Without targetChance it returns null.
 */

export type UpgraderMetadata = {
  /** Target cashout multiplier, e.g. 5 for "5×". Null if not present. */
  targetMultiplier: number | null;
  /**
   * Target win chance, as a PERCENTAGE (0-100 range). Null if neither
   * stored directly nor derivable from targetMultiplier.
   */
  targetChance: number | null;
  /**
   * True when targetChance was DERIVED from targetMultiplier (assuming
   * a house edge of zero — see houseEdge field). The UI can render an
   * "≈" prefix to flag the approximation.
   */
  targetChanceDerived: boolean;
  /**
   * House edge as a fraction (0.05 = 5%). Null if not present in the
   * metadata.
   */
  houseEdge: number | null;
  /**
   * The raw roll value the server produced for this spin. Format is
   * backend-defined (0-1 float, 0-100, 0-10000 are all common). Null
   * if not present.
   */
  roll: number | null;
};

/** Top-level + nested JSON object keys the backend may tuck config under. */
export const UPGRADER_NESTED_OBJECT_KEYS = [
  "config",
  "upgrader",
  "play",
  "game",
  "params",
  "settings",
  "bet",
  "spin",
] as const;

export const UPGRADER_MULTIPLIER_KEYS = [
  "target_multiplier",
  "targetMultiplier",
  "selected_multiplier",
  "selectedMultiplier",
  "upgrade_multiplier",
  "upgradeMultiplier",
  "desired_multiplier",
  "desiredMultiplier",
  "multiplier",
  "target_payout",
  "payout_multiplier",
  "cashout_multiplier",
  "cashout",
  "payout",
  "target_x",
  "targetX",
  "win_multiplier",
  "winMultiplier",
] as const;

export const UPGRADER_CHANCE_KEYS = [
  "target_chance",
  "targetChance",
  "win_chance",
  "winChance",
  "chance",
  "probability",
  "win_probability",
  "winProbability",
] as const;

export const UPGRADER_HOUSE_EDGE_KEYS = [
  "house_edge",
  "houseEdge",
  "edge",
] as const;

export const UPGRADER_ROLL_KEYS = [
  "roll",
  "result",
  "random",
  "random_value",
  "roll_value",
  "result_value",
] as const;

/**
 * Build a SQL COALESCE expression that reads a target multiplier off a
 * JSON/JSONB column. Pass the column expression (e.g.
 * `pf.result_metadata` or `lt.metadata`). Mirrors the candidate-key
 * list used by `parseUpgraderMetadata`, including one-level nested
 * objects (`config`, `upgrader`, `play`, ...).
 */
export function upgraderTargetMultiplierSql(metadataJsonExpr: string): string {
  const parts: string[] = [];
  for (const key of UPGRADER_MULTIPLIER_KEYS) {
    parts.push(
      `NULLIF(${metadataJsonExpr}->>'${key}', '')::numeric`,
    );
    for (const nest of UPGRADER_NESTED_OBJECT_KEYS) {
      parts.push(
        `NULLIF(${metadataJsonExpr}->'${nest}'->>'${key}', '')::numeric`,
      );
    }
  }
  return `COALESCE(\n        ${parts.join(",\n        ")}\n      )`;
}

/** SQL COALESCE for explicit win-chance keys (0-1 fraction or 0-100 %). */
export function upgraderTargetChanceSql(metadataJsonExpr: string): string {
  const parts: string[] = [];
  for (const key of UPGRADER_CHANCE_KEYS) {
    parts.push(
      `NULLIF(${metadataJsonExpr}->>'${key}', '')::numeric`,
    );
    for (const nest of UPGRADER_NESTED_OBJECT_KEYS) {
      parts.push(
        `NULLIF(${metadataJsonExpr}->'${nest}'->>'${key}', '')::numeric`,
      );
    }
  }
  return `COALESCE(\n        ${parts.join(",\n        ")}\n      )`;
}

/**
 * Read a number from an unknown value — accepts native numbers and
 * stringified numbers. Returns null for anything else.
 */
function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Try a list of candidate keys on a record, returning the first
 * resolvable number. Used because the metadata field name convention
 * isn't pinned by the backend.
 */
function pickNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (key in record) {
      const n = readNumber(record[key]);
      if (n != null) return n;
    }
  }
  return null;
}

/** Flatten a metadata blob into root + known nested object records. */
function collectMetadataRecords(metadata: unknown): Record<string, unknown>[] {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const root = metadata as Record<string, unknown>;
  const records: Record<string, unknown>[] = [root];
  for (const key of UPGRADER_NESTED_OBJECT_KEYS) {
    const nested = root[key];
    if (nested != null && typeof nested === "object" && !Array.isArray(nested)) {
      records.push(nested as Record<string, unknown>);
    }
  }
  return records;
}

function pickNumberDeep(
  metadata: unknown,
  keys: readonly string[],
): number | null {
  for (const record of collectMetadataRecords(metadata)) {
    const n = pickNumber(record, keys);
    if (n != null) return n;
  }
  return null;
}

function parseUpgraderMetadataFromRecord(
  metadata: unknown,
): UpgraderMetadata {
  const empty: UpgraderMetadata = {
    targetMultiplier: null,
    targetChance: null,
    targetChanceDerived: false,
    houseEdge: null,
    roll: null,
  };
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return empty;
  }

  const targetMultiplier = pickNumberDeep(metadata, UPGRADER_MULTIPLIER_KEYS);
  const targetChanceRaw = pickNumberDeep(metadata, UPGRADER_CHANCE_KEYS);
  const houseEdge = pickNumberDeep(metadata, UPGRADER_HOUSE_EDGE_KEYS);
  const roll = pickNumberDeep(metadata, UPGRADER_ROLL_KEYS);

  let targetChance: number | null = null;
  if (targetChanceRaw != null) {
    targetChance =
      targetChanceRaw > 0 && targetChanceRaw <= 1
        ? targetChanceRaw * 100
        : Math.min(100, targetChanceRaw);
  }

  let targetChanceDerived = false;
  if (targetChance == null && targetMultiplier != null && targetMultiplier > 1) {
    const edgeFraction = houseEdge ?? 0;
    const derived = ((1 - edgeFraction) / targetMultiplier) * 100;
    if (Number.isFinite(derived) && derived > 0 && derived <= 100) {
      targetChance = derived;
      targetChanceDerived = true;
    }
  }

  return {
    targetMultiplier,
    targetChance,
    targetChanceDerived,
    houseEdge,
    roll,
  };
}

/**
 * Parse upgrader play context out of a `provably_fair_results.result_metadata`
 * blob. Returns a struct with every field resolved to either a number
 * or null. Safe to call with any value (returns the all-null shape for
 * non-objects / nulls).
 */
export function parseUpgraderMetadata(metadata: unknown): UpgraderMetadata {
  return parseUpgraderMetadataFromRecord(metadata);
}

/**
 * Merge multiple metadata sources (PF rows, ledger metadata, Prisma
 * includes) — first non-null field wins per attribute. Callers pass
 * sources in priority order (most authoritative first).
 */
export function resolveUpgraderMetadata(
  ...sources: unknown[]
): UpgraderMetadata {
  const empty: UpgraderMetadata = {
    targetMultiplier: null,
    targetChance: null,
    targetChanceDerived: false,
    houseEdge: null,
    roll: null,
  };
  const merged = { ...empty };
  for (const source of sources) {
    if (source == null) continue;
    const parsed = parseUpgraderMetadataFromRecord(source);
    if (merged.targetMultiplier == null && parsed.targetMultiplier != null) {
      merged.targetMultiplier = parsed.targetMultiplier;
    }
    if (merged.targetChance == null && parsed.targetChance != null) {
      merged.targetChance = parsed.targetChance;
      merged.targetChanceDerived = parsed.targetChanceDerived;
    }
    if (merged.houseEdge == null && parsed.houseEdge != null) {
      merged.houseEdge = parsed.houseEdge;
    }
    if (merged.roll == null && parsed.roll != null) {
      merged.roll = parsed.roll;
    }
  }
  return merged;
}

/**
 * Format a multiplier number as a compact display string:
 *   • < 10×   → one decimal (e.g. 2.5×, 8.3×)
 *   • < 1000× → integer    (e.g. 12×, 100×)
 *   • ≥ 1000× → k-suffixed (e.g. 1.2k×)
 *
 * Mirrors the formatter used in upgrader data-table / dialog so the
 * same multiplier reads identically across surfaces.
 */
export function formatUpgraderMultiplier(m: number): string {
  if (m < 10) return `${m.toFixed(1)}×`;
  if (m < 1000) return `${Math.round(m)}×`;
  return `${(m / 1000).toFixed(1)}k×`;
}

/**
 * Format a chance percentage as "19.8%". Trims a trailing ".0" for
 * round values (so "50%" instead of "50.0%"). Returns "—" for null.
 */
export function formatUpgraderChance(pct: number | null): string {
  if (pct == null) return "—";
  if (pct >= 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}
