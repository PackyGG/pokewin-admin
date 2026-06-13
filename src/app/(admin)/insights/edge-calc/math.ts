/**
 * Pure math helpers for the Edge Calc page.
 *
 * Everything here is side-effect-free and dep-free so the scenario
 * builder (client component) can call the same functions the server
 * uses to render the static panels. All inputs are primitive numbers;
 * all outputs are primitive numbers — no Decimal objects cross this
 * boundary so the React state machine stays serializable.
 */

// ─── House-edge target ────────────────────────────────────────────────

/**
 * Target theoretical house edge used to auto-suggest a pack's sticker
 * price from its EV (see `suggestedPriceFromEv`). 0.1099 = 10.99% edge.
 *
 * Centralised here (the dep-free, client-safe math module) so the
 * pack create/edit dialogs and any future surface tune the same knob.
 * Changing this value only affects NEW suggestions going forward — it
 * never re-prices existing packs.
 */
export const TARGET_HOUSE_EDGE = 0.1099;

/**
 * Suggested sticker price for a pack given its expected payout per open
 * (EV) at the `TARGET_HOUSE_EDGE`.
 *
 *   house edge = (price − EV) / price
 *   ⇒ EV / price = 1 − edge
 *   ⇒ price       = EV / (1 − edge)
 *
 * At the default 10.99% edge: price = EV / 0.8901. Returns a value
 * rounded to 2 decimals (the DB stores price as Decimal(20,2)). Returns
 * 0 for a non-positive EV (no pool / free pack — nothing to suggest).
 */
export function suggestedPriceFromEv(
  evPerOpen: number,
  targetHouseEdge: number = TARGET_HOUSE_EDGE,
): number {
  if (!Number.isFinite(evPerOpen) || evPerOpen <= 0) return 0;
  const denom = 1 - targetHouseEdge;
  if (denom <= 0) return 0;
  return Math.round((evPerOpen / denom) * 100) / 100;
}

// ─── Pack EV ──────────────────────────────────────────────────────────

export type PackEvBreakdown = {
  /** Expected per-card payout: SUM(weight × price) / SUM(weight). */
  expectedCardValue: number;
  /** Expected total payout per open: expectedCardValue × cardsPerOpen. */
  expectedPayoutPerOpen: number;
  /** Theoretical RTP as a 0-1 fraction. NaN-safe (0 when price is 0). */
  rtp: number;
  /** Theoretical house edge = 1 − rtp. */
  houseEdge: number;
};

/**
 * Expected payout per open from a pack's pool composition.
 *
 *   E[V_card]   = SUM(weight × price) / SUM(weight)
 *   E[Payout]   = E[V_card] × cardsPerOpen
 *   RTP         = E[Payout] / pricePerOpen
 *   House edge  = 1 − RTP
 *
 * Independent draws (with replacement) are assumed — that matches how
 * the backend opens packs (each slot rolls the PF function fresh from
 * the same weighted pool). The formula above is exact for that model,
 * not an approximation.
 */
export function computePackEv(input: {
  pricePerOpen: number;
  cardsPerOpen: number;
  totalWeight: number;
  weightedPriceSum: number;
}): PackEvBreakdown {
  const { pricePerOpen, cardsPerOpen, totalWeight, weightedPriceSum } = input;
  const expectedCardValue = totalWeight > 0 ? weightedPriceSum / totalWeight : 0;
  const expectedPayoutPerOpen = expectedCardValue * cardsPerOpen;
  const rtp =
    pricePerOpen > 0 && expectedPayoutPerOpen > 0
      ? expectedPayoutPerOpen / pricePerOpen
      : 0;
  return {
    expectedCardValue,
    expectedPayoutPerOpen,
    rtp,
    houseEdge: 1 - rtp,
  };
}

// ─── Inverse odds from target EV ─────────────────────────────────────

export type ComputeOddsForTargetEvResult =
  | { odds: number[] }
  | { error: string };

const TARGET_EV_MIN = 0.001;
const TARGET_EV_MAX = 5000;

function expectedCardValueForBeta(prices: readonly number[], beta: number): number {
  const weights = prices.map((p) => Math.pow(p, -beta));
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return 0;
  const weightedSum = weights.reduce((s, w, i) => s + w * prices[i]!, 0);
  return weightedSum / sumW;
}

/** Round odds to 4 decimals and nudge the largest bucket so the total is 100%. */
export function normalizeOddsTo100(rawOdds: readonly number[]): number[] {
  const rounded = rawOdds.map((o) => Math.round(o * 10000) / 10000);
  const sum = rounded.reduce((a, b) => a + b, 0);
  const diff = Math.round((100 - sum) * 10000) / 10000;
  if (Math.abs(diff) < 0.0001) return rounded;

  let maxIdx = 0;
  for (let i = 1; i < rounded.length; i++) {
    if (rounded[i]! > rounded[maxIdx]!) maxIdx = i;
  }
  rounded[maxIdx] = Math.round((rounded[maxIdx]! + diff) * 10000) / 10000;
  return rounded;
}

/**
 * Solve for per-card odds (percentages summing to 100) that yield a target
 * expected payout per open, given fixed card prices and cards-per-open.
 *
 * Uses a power-law weight template `w_i = price_i^(-β)` and binary-searches
 * β so the normalized weights hit the target per-card EV. Feasible targets
 * lie between min(price) and max(price) per card (× cardsPerOpen per open).
 */
export function computeOddsForTargetEv(
  cards: readonly { priceUsd: number }[],
  targetEvPerOpen: number,
  cardsPerOpen: number,
): ComputeOddsForTargetEvResult {
  if (cards.length === 0) {
    return { error: "Add at least one card first." };
  }
  if (
    !Number.isFinite(targetEvPerOpen) ||
    targetEvPerOpen < TARGET_EV_MIN ||
    targetEvPerOpen > TARGET_EV_MAX
  ) {
    return { error: `Target EV must be between $${TARGET_EV_MIN} and $${TARGET_EV_MAX}.` };
  }
  if (!Number.isFinite(cardsPerOpen) || cardsPerOpen < 1) {
    return { error: "Cards per open must be at least 1." };
  }

  const prices = cards.map((c) => c.priceUsd);
  const targetCardValue = targetEvPerOpen / cardsPerOpen;
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const tol = 1e-4;

  if (targetCardValue < minP - tol || targetCardValue > maxP + tol) {
    return {
      error: `Target implies $${targetCardValue.toFixed(4)}/card; pool range is $${minP.toFixed(2)}–$${maxP.toFixed(2)}.`,
    };
  }

  if (cards.length === 1) {
    if (Math.abs(prices[0]! - targetCardValue) > tol) {
      return { error: "Single-card pool can only match EV equal to that card's price." };
    }
    return { odds: [100] };
  }

  if (minP === maxP) {
    if (Math.abs(prices[0]! - targetCardValue) > tol) {
      return {
        error: `All cards are $${prices[0]!.toFixed(2)}; target must be $${(prices[0]! * cardsPerOpen).toFixed(4)}/open.`,
      };
    }
    const each = 100 / cards.length;
    return { odds: normalizeOddsTo100(cards.map(() => each)) };
  }

  const evLo = expectedCardValueForBeta(prices, -20);
  const evHi = expectedCardValueForBeta(prices, 50);

  if (targetCardValue > evLo + tol) {
    return {
      error: `Target exceeds max achievable EV ($${(evLo * cardsPerOpen).toFixed(4)}/open) for this pool.`,
    };
  }
  if (targetCardValue < evHi - tol) {
    return {
      error: `Target is below min achievable EV ($${(evHi * cardsPerOpen).toFixed(4)}/open) for this pool.`,
    };
  }

  let lo = -20;
  let hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const ev = expectedCardValueForBeta(prices, mid);
    if (ev > targetCardValue) lo = mid;
    else hi = mid;
  }

  const beta = (lo + hi) / 2;
  const weights = prices.map((p) => Math.pow(p, -beta));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const rawOdds = weights.map((w) => (w / sumW) * 100);

  return { odds: normalizeOddsTo100(rawOdds) };
}

// ─── Upgrader EV ──────────────────────────────────────────────────────

export type UpgraderEvBreakdown = {
  /** Win probability the user actually has at this multiplier. */
  winProbability: number;
  /** Expected payout per $1 bet: multiplier × winProbability. */
  expectedPayoutPer1: number;
  /** Theoretical RTP for the upgrader play (0-1 fraction). */
  rtp: number;
  /** Theoretical house edge = 1 − RTP. */
  houseEdge: number;
};

/**
 * Upgrader EV for a target multiplier at a given house edge.
 *
 *   chance = (1 − edge) / multiplier            (textbook fair-game inverse)
 *   payoutPer$1 = multiplier × chance = 1 − edge
 *   rtp = payoutPer$1
 *
 * Edges are passed as fractions (0.05 = 5%). Multipliers ≤ 1 short-
 * circuit to a 0-payout row (no upgrade = no game).
 */
export function computeUpgraderEv(input: {
  multiplier: number;
  houseEdge: number;
}): UpgraderEvBreakdown {
  const { multiplier, houseEdge } = input;
  if (multiplier <= 1) {
    return {
      winProbability: 0,
      expectedPayoutPer1: 0,
      rtp: 0,
      houseEdge: 1,
    };
  }
  const edge = Math.max(0, Math.min(1, houseEdge));
  const winProbability = Math.min(1, (1 - edge) / multiplier);
  const expectedPayoutPer1 = multiplier * winProbability;
  return {
    winProbability,
    expectedPayoutPer1,
    rtp: expectedPayoutPer1,
    houseEdge: 1 - expectedPayoutPer1,
  };
}

// ─── Scenario simulator ──────────────────────────────────────────────

export type ScenarioInput = {
  /** Pack sticker price (USD per open). */
  packPrice: number;
  /** Theoretical RTP of the pack (0-1). */
  packRtp: number;
  /** How many times the user opens this pack in the scenario. */
  repetitions: number;
  /**
   * Borrow percentage (0-100). The user pays `(1 − borrow/100) × price`
   * out of pocket per open; the house lends the rest, and recoups it
   * from the payout (so the user only sees their share of the EV).
   * Modelled the same way the backend's borrow mechanic does it — see
   * /transactions/packs borrow notes.
   */
  borrowPct: number;
  /**
   * Deposit-bonus rate (0-100). Adds to the user's effective bankroll
   * at the start of the scenario, treated as wager-able cash. Bonus is
   * a house cost — the projected P&L subtracts it.
   */
  depositBonusPct: number;
  /**
   * Rakeback rate (0-100). The user claws back this fraction of total
   * wager. Modeled as a flat refund applied at scenario end, mirroring
   * how the live rakeback config works (`rakeback_config.percentage`).
   */
  rakebackPct: number;
  /**
   * Initial deposit. Drives the deposit-bonus calculation; also used as
   * the user's wager bankroll cap.
   */
  deposit: number;
};

export type ScenarioResult = {
  /** Sticker cost across the whole scenario: repetitions × packPrice. */
  grossCost: number;
  /** User out-of-pocket cost when borrowing: (1 − borrow) × grossCost. */
  userOutOfPocket: number;
  /** Deposit bonus the house gives away. */
  depositBonusGiven: number;
  /**
   * Expected total payout in card value. With borrow the user only
   * keeps their share, since the house recoups the lent slice off the
   * top of each open. We model this as a proportional split so the
   * scenario stays linear in `repetitions` (admin-friendly).
   */
  expectedPayout: number;
  /** Expected card value the user takes home (post-borrow). */
  expectedUserPayout: number;
  /** Rakeback the user claims back, computed off grossCost (the wager). */
  rakebackClaimed: number;
  /** Net user P&L = expectedUserPayout − userOutOfPocket + rakeback. */
  userPnl: number;
  /**
   * House P&L from this scenario — the inverse of `userPnl` flipped by
   * the bonus given (which the house also eats):
   *   housePnl = grossCost − expectedPayout − bonus − rakeback
   *            + (grossCost − userOutOfPocket)   // borrow recouped
   * Collapses to: userOutOfPocket − expectedUserPayout − bonus − rakeback.
   */
  housePnl: number;
  /**
   * Break-even point in repetitions — how many opens before user's
   * expected P&L crosses 0. Null when EV is non-positive (user never
   * recovers from house edge).
   */
  breakEvenOpens: number | null;
};

export function runScenario(input: ScenarioInput): ScenarioResult {
  const { packPrice, packRtp, repetitions, borrowPct, depositBonusPct, rakebackPct, deposit } = input;
  const borrow = Math.max(0, Math.min(100, borrowPct)) / 100;
  const bonus = Math.max(0, depositBonusPct) / 100;
  const rake = Math.max(0, rakebackPct) / 100;

  const grossCost = packPrice * repetitions;
  const userOutOfPocket = grossCost * (1 - borrow);
  const depositBonusGiven = deposit * bonus;
  const expectedPayout = grossCost * packRtp;
  // User keeps the post-borrow share of EV. The borrow split is the
  // same proportion for the payout as for the wager so the user's RTP
  // (expectedUserPayout / userOutOfPocket) equals the pack's RTP — the
  // borrow ratio cancels. Modeled this way deliberately so the table
  // can read "user RTP under borrow = pack RTP" cleanly.
  const expectedUserPayout = expectedPayout * (1 - borrow);
  const rakebackClaimed = grossCost * rake;

  const userPnl = expectedUserPayout - userOutOfPocket + rakebackClaimed + depositBonusGiven;
  // House P&L is the inverse of user P&L (every dollar the user has is
  // a dollar we owe). Including bonus + rakeback as house outflows.
  const housePnl = -userPnl;

  // Break-even: how many opens until the user's net is zero. Without
  // borrow it's `bonus / (price − price × rtp − rake × price)` =
  // `bonus / (price × (1 − rtp − rake))`. With borrow we scale price
  // by (1 − borrow). Returns null when the denominator is non-positive
  // (user can't recover from the edge).
  const perOpenUserCost = packPrice * (1 - borrow);
  const perOpenUserEv = packPrice * packRtp * (1 - borrow) + packPrice * rake;
  const perOpenUserNet = perOpenUserEv - perOpenUserCost;
  const breakEvenOpens =
    perOpenUserNet > 0 && depositBonusGiven > 0
      ? depositBonusGiven / perOpenUserNet
      : perOpenUserNet > 0
        ? 0
        : null;

  return {
    grossCost,
    userOutOfPocket,
    depositBonusGiven,
    expectedPayout,
    expectedUserPayout,
    rakebackClaimed,
    userPnl,
    housePnl,
    breakEvenOpens,
  };
}

// ─── Bonus stack ROI ─────────────────────────────────────────────────

export type BonusStackInput = {
  /** Deposit size, USD. */
  deposit: number;
  /** Bonus rate, 0-100. */
  bonusPct: number;
  /** Wager requirement multiple of the bonus (e.g. 5 = 5× bonus). */
  wagerRequirementX: number;
  /** Pack RTP used to score the wager (0-1). */
  packRtp: number;
};

export type BonusStackResult = {
  /** Bonus given (deposit × bonusPct/100). */
  bonusGiven: number;
  /** Total wager required (wagerRequirementX × bonusGiven). */
  wagerRequired: number;
  /** Expected house GGR from that wager. */
  expectedHouseGgr: number;
  /**
   * House break-even when expectedHouseGgr ≥ bonusGiven. The user can
   * still rake on the bonus on top of clearing the wager — that's how
   * "100% deposit bonus to 5× wager" usually pencils out.
   */
  houseBreakEven: boolean;
  /** Net house P&L (expectedHouseGgr − bonusGiven). */
  netHousePnl: number;
  /**
   * Required wager multiple to break even on the bonus, given the
   * pack edge:
   *   wagerRequirementX_breakeven = 1 / (1 − rtp)
   * E.g. 25% house edge → 4× wager just to recover the bonus.
   */
  breakEvenWagerX: number | null;
};

export function runBonusStack(input: BonusStackInput): BonusStackResult {
  const { deposit, bonusPct, wagerRequirementX, packRtp } = input;
  const bonus = Math.max(0, bonusPct) / 100;
  const bonusGiven = deposit * bonus;
  const wagerRequired = wagerRequirementX * bonusGiven;
  const houseEdge = 1 - packRtp;
  const expectedHouseGgr = wagerRequired * houseEdge;
  const netHousePnl = expectedHouseGgr - bonusGiven;
  const breakEvenWagerX = houseEdge > 0 ? 1 / houseEdge : null;
  return {
    bonusGiven,
    wagerRequired,
    expectedHouseGgr,
    houseBreakEven: netHousePnl >= 0,
    netHousePnl,
    breakEvenWagerX,
  };
}

// ─── Format helpers (used by client components, kept here so the same
//     formatter is reused in tooltips / labels without an extra import) ──

export function formatPct(fraction: number, decimals = 2): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value))}`;
}
