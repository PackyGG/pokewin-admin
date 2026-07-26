import type { MainDrizzleDb } from "@/lib/db";
import { queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { toNumber } from "@/lib/utils/decimal";

/**
 * prize-valuation.ts — the SHARED raffle prize parsing + valuation helper.
 *
 * Raffle prizes are NOT a ledger money leg — each `raffles` row carries a
 * `prizes` JSON array (`[{ type:'pack'|'card', id, quantity? }]`) and the
 * cost has to be RECONSTRUCTED by valuing each line at the live item price
 * (`packs.price` / `cards.price` × quantity), exactly like the raffle
 * detail page does.
 *
 * Extracted from `raffle/overview.ts` (the forecast baseline) so the Edge
 * Plan 2.0 baseline can value LIVE (active) raffles with the SAME math —
 * one valuation, two consumers, no drift.
 *
 * READ-ONLY: two `IN (…)` price lookups, nothing else.
 */

/** A single parsed prize line. */
export type RafflePrizeLine = {
  type: "pack" | "card";
  id: string;
  quantity: number;
};

/** Defensive parse of the `prizes` JSON into well-formed prize lines. */
export function parseRafflePrizes(raw: unknown): RafflePrizeLine[] {
  if (!Array.isArray(raw)) return [];
  const out: RafflePrizeLine[] = [];
  for (const p of raw) {
    if (p == null || typeof p !== "object") continue;
    const rec = p as Record<string, unknown>;
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "pack" && type !== "card") ||
      typeof id !== "string" ||
      id.length === 0
    ) {
      continue;
    }
    const qtyRaw = Number(rec.quantity);
    const quantity =
      Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;
    out.push({ type, id, quantity });
  }
  return out;
}

/** Values prize-line sets against the price maps loaded once per batch. */
export type RafflePrizeValuator = {
  /** Σ price × qty across the given lines. Unknown items value at $0. */
  valueLines: (lines: readonly RafflePrizeLine[]) => number;
  /** Unit price for a single line's item ($0 when unknown). */
  unitPriceUsd: (line: RafflePrizeLine) => number;
};

/**
 * Load the referenced pack/card prices ONCE (two `IN (…)` lookups across the
 * whole batch — never per-raffle) and return a pure valuator.
 */
export async function buildRafflePrizeValuator(
  db: MainDrizzleDb,
  allLines: readonly RafflePrizeLine[],
): Promise<RafflePrizeValuator> {
  const packIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const line of allLines) {
    if (line.type === "pack") packIds.add(line.id);
    else cardIds.add(line.id);
  }

  const [packRows, cardRows] = await Promise.all([
    packIds.size > 0
      ? queryRows<Array<{ id: string; price: string }>>(
          db,
          sql`SELECT id, price::text AS price
              FROM packs
              WHERE id IN (${sql.join(
                [...packIds].map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
        )
      : Promise.resolve([] as Array<{ id: string; price: unknown }>),
    cardIds.size > 0
      ? queryRows<Array<{ id: string; price: string }>>(
          db,
          sql`SELECT id, price::text AS price
              FROM cards
              WHERE id IN (${sql.join(
                [...cardIds].map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
        )
      : Promise.resolve([] as Array<{ id: string; price: unknown }>),
  ]);

  const packPrice = new Map(packRows.map((p) => [p.id, toNumber(p.price)]));
  const cardPrice = new Map(cardRows.map((c) => [c.id, toNumber(c.price)]));

  const unitPriceUsd = (line: RafflePrizeLine): number =>
    line.type === "pack"
      ? (packPrice.get(line.id) ?? 0)
      : (cardPrice.get(line.id) ?? 0);

  return {
    unitPriceUsd,
    valueLines: (lines) => {
      let sum = 0;
      for (const line of lines) {
        sum += unitPriceUsd(line) * line.quantity;
      }
      return sum;
    },
  };
}
