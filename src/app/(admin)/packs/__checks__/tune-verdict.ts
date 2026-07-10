/**
 * Retune V3 wave 2b harness — the pack-tune VERDICT builder (pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/tune-verdict.ts"
 *
 * Pins the v9 server contract's `buildPackTuneVerdict` (tag-guidance.ts):
 * the ONE worst-first decision tree the plan panel renders before anything
 * else. Every check is a contract the wave-2c UI builds on:
 *
 *   1. RANKING — refusals outrank quality flags, and within each block the
 *      order is fixed: tag-contradiction > pins-infeasible >
 *      monotone-unreachable > tag-unreachable > refused (generic limit /
 *      write-assert) > off-tag > degenerate > unsnapped > off-nice > healthy.
 *   2. PASSTHROUGH — the WHY is the engine's verbatim (`limit.detail`,
 *      refusal message, contradiction copy); the action is `limit.suggestion`
 *      or the derived window-proven retag line; nothing is re-worded.
 *   3. LAW T SURFACE — `fitProbed`/`fitRange` come from the guidance's
 *      `shapeFit` on EVERY kind (the retag slider binds to `fitRange`), and
 *      "probe ran, no tag fits" is distinguishable from "probe never ran".
 *   4. PINS — a pins-infeasible verdict carries the verified remedies + the
 *      `pinShortfallHumanCopy` shortfall copy in one shape; an empty remedy
 *      list ships the honest "pins interlock" copy.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  buildPackTuneVerdict,
  type PackTuneVerdictInput,
  type PinRemedy,
  type TagGuidance,
} from "../../insights/edge-calc/tag-guidance";

let passes = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseInput = (
  over: Partial<PackTuneVerdictInput>,
): PackTuneVerdictInput => ({
  feasible: true,
  limit: null,
  tagContradiction: null,
  refusalMessage: null,
  refusalCode: null,
  tagged: false,
  taggedAccuracyHit: null,
  snapped: true,
  allNice: null,
  shapeDegenerate: false,
  guidance: null,
  price: 100,
  targetEdge: 0.12,
  ...over,
});

const guidanceWith = (
  shapeFit:
    | {
        monotoneFeasible: boolean;
        monotoneEvMin: number;
        monotoneEvMax: number;
        fitRange: { minFit: number; maxFit: number } | null;
      }
    | undefined,
): TagGuidance => ({
  feasibility: {
    evTarget: 88,
    evMin: 90,
    evMax: 110,
    feasible: false,
    saturated: false,
    direction: "need-ev-down",
    components: { winEvMin: 0, winEvMax: 0, nmMass: 0, dustMass: 0, capSum: 0 },
    ...(shapeFit !== undefined ? { shapeFit } : {}),
  },
  suggestions: [],
});

const FIT = { minFit: 0.001, maxFit: 0.0326 };
const fitGuidance = guidanceWith({
  monotoneFeasible: false,
  monotoneEvMin: 0,
  monotoneEvMax: 0,
  fitRange: FIT,
});
const noFitGuidance = guidanceWith({
  monotoneFeasible: false,
  monotoneEvMin: 0,
  monotoneEvMax: 0,
  fitRange: null,
});
const unprobedGuidance = guidanceWith(undefined);

const remedyA: PinRemedy = {
  kind: "raise-pin",
  cardIndex: 1,
  cardValue: 3419.4,
  fromPct: 1,
  toPct: 1.85,
  edge: 0.1102,
  humanCopy: "Raise the $3,419.40 pin from 1% to 1.85%.",
  verified: true,
};
const remedyB: PinRemedy = {
  kind: "price-move",
  price: 389.25,
  edge: 0.1099,
  humanCopy: "Move the price to $389.25.",
  verified: true,
};

// ── 1. Quality-flag ladder (feasible arm) ────────────────────────────────────

check("healthy baseline: clean kind, no detail/action, no fit, no remedies", () => {
  const v = buildPackTuneVerdict(baseInput({}));
  assert(v.kind === "healthy", `kind ${v.kind}`);
  assert(v.headline === "Clean plan — ready to push.", `headline ${v.headline}`);
  assert(v.detail === null && v.action === null, "detail/action must be null");
  assert(v.fitProbed === false && v.fitRange === null, "no fit probe ran");
  assert(v.pinRemedies === null, "no remedies on a healthy plan");
});

check("tagged healthy: exact tag + nice grid stays healthy", () => {
  const v = buildPackTuneVerdict(
    baseInput({ tagged: true, taggedAccuracyHit: true, allNice: true }),
  );
  assert(v.kind === "healthy", `kind ${v.kind}`);
});

check("off-nice: tagged + allNice false", () => {
  const v = buildPackTuneVerdict(
    baseInput({ tagged: true, taggedAccuracyHit: true, allNice: false }),
  );
  assert(v.kind === "off-nice", `kind ${v.kind}`);
  assert(v.headline === "Exact per-100k odds, but not human-nice.", v.headline);
});

check("allNice is tagged-only: untagged allNice=false stays healthy", () => {
  const v = buildPackTuneVerdict(baseInput({ tagged: false, allNice: false }));
  assert(v.kind === "healthy", `kind ${v.kind}`);
});

check("unsnapped outranks off-nice", () => {
  const v = buildPackTuneVerdict(
    baseInput({ tagged: true, snapped: false, allNice: false }),
  );
  assert(v.kind === "unsnapped", `kind ${v.kind}`);
  assert(
    v.headline === "The plan can't land on clean odds at this price.",
    v.headline,
  );
});

check("degenerate outranks unsnapped", () => {
  const v = buildPackTuneVerdict(
    baseInput({ shapeDegenerate: true, snapped: false }),
  );
  assert(v.kind === "degenerate", `kind ${v.kind}`);
});

check("off-tag outranks degenerate (tag law above the shape lens)", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      tagged: true,
      taggedAccuracyHit: false,
      shapeDegenerate: true,
      snapped: false,
    }),
  );
  assert(v.kind === "off-tag", `kind ${v.kind}`);
  assert(v.headline === "The plan misses the exact tag hit-rate.", v.headline);
});

check("taggedAccuracyHit is tagged-only: untagged miss stays on the shape flag", () => {
  const v = buildPackTuneVerdict(
    baseInput({ tagged: false, taggedAccuracyHit: false, shapeDegenerate: true }),
  );
  assert(v.kind === "degenerate", `kind ${v.kind}`);
});

// ── 2. Refusal block ─────────────────────────────────────────────────────────

check("write-assert refusal: refused kind + verbatim message", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      refusalCode: "win-rate-miss",
      refusalMessage: "The landed win-rate misses the target by 3.1pp.",
    }),
  );
  assert(v.kind === "refused", `kind ${v.kind}`);
  assert(v.headline === "The plan fails a write-time law.", v.headline);
  assert(
    v.detail === "The landed win-rate misses the target by 3.1pp.",
    `detail ${v.detail}`,
  );
  assert(v.action === null, "write-assert refusals carry no single action");
});

check("bare infeasible safety net: refused with generic copy", () => {
  const v = buildPackTuneVerdict(baseInput({ feasible: false }));
  assert(v.kind === "refused", `kind ${v.kind}`);
  assert(v.headline === "The engine refused this plan.", v.headline);
  assert(v.detail === null && v.action === null, "nothing to pass through");
});

check("generic limit (empty-pool): refused + detail/suggestion passthrough", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: {
        kind: "empty-pool",
        detail: "This pack has no cards in its pool.",
        suggestion: "Add cards in the Builder.",
      },
    }),
  );
  assert(v.kind === "refused", `kind ${v.kind}`);
  assert(v.detail === "This pack has no cards in its pool.", `detail ${v.detail}`);
  assert(v.action === "Add cards in the Builder.", `action ${v.action}`);
});

check("refusal outranks every quality flag", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      refusalCode: "edge-above-band",
      refusalMessage: "Edge above band.",
      tagged: true,
      taggedAccuracyHit: false,
      shapeDegenerate: true,
      snapped: false,
      allNice: false,
    }),
  );
  assert(v.kind === "refused", `kind ${v.kind}`);
});

// ── 3. Typed engine verdicts (LAW M / LAW T / pins) ──────────────────────────

check("monotone-unreachable: typed kind + passthrough", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: {
        kind: "monotone-unreachable",
        detail: "No monotone ladder pays this tag.",
        suggestion: "Add a mid card near $40.",
      },
    }),
  );
  assert(v.kind === "monotone-unreachable", `kind ${v.kind}`);
  assert(
    v.headline === "No lawful odds ladder can pay this tag at this price.",
    v.headline,
  );
  assert(v.detail === "No monotone ladder pays this tag.", `detail ${v.detail}`);
  assert(v.action === "Add a mid card near $40.", `action ${v.action}`);
});

check("tag-unreachable: engine suggestion wins the action slot", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      tagged: true,
      limit: {
        kind: "tag-unreachable",
        detail: "No lawful ladder hosts the 50% tag at $6.00.",
        suggestion: "Retag to 3.26% or below.",
      },
      guidance: fitGuidance,
    }),
  );
  assert(v.kind === "tag-unreachable", `kind ${v.kind}`);
  assert(v.action === "Retag to 3.26% or below.", `action ${v.action}`);
  assert(v.fitProbed === true, "fit probe ran");
  assert(
    v.fitRange !== null &&
      v.fitRange.minFit === FIT.minFit &&
      v.fitRange.maxFit === FIT.maxFit,
    "fitRange must be the guidance's LAW T window, verbatim",
  );
});

check("tag-unreachable without engine suggestion: window-proven retag line", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      tagged: true,
      limit: {
        kind: "tag-unreachable",
        detail: "No lawful ladder hosts the 50% tag at $6.00.",
        suggestion: "",
      },
      guidance: fitGuidance,
    }),
  );
  assert(v.kind === "tag-unreachable", `kind ${v.kind}`);
  assert(v.action !== null, "derived retag action expected");
  assert(
    v.action.includes("Retag between 0.10% and 3.26%") &&
      v.action.includes("window-proven"),
    `action ${v.action}`,
  );
});

check("tag-unreachable, probe ran, NO tag fits: fitProbed true + fitRange null", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      tagged: true,
      limit: { kind: "tag-unreachable", detail: "No tag fits.", suggestion: "" },
      guidance: noFitGuidance,
    }),
  );
  assert(v.kind === "tag-unreachable", `kind ${v.kind}`);
  assert(v.fitProbed === true, "probe ran");
  assert(v.fitRange === null, "no tag fits");
  assert(v.action === null, "no engine suggestion and no window to derive from");
});

check("pins-infeasible: remedies + shortfall copy in one shape", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: {
        kind: "pins-infeasible",
        detail: "Pinned EV tops out at $375.43 vs the $384.15 floor.",
        suggestion: "",
      },
      pinRemedies: [remedyA, remedyB],
    }),
  );
  assert(v.kind === "pins-infeasible", `kind ${v.kind}`);
  assert(
    v.headline === "The pinned odds make this tune impossible at this price.",
    v.headline,
  );
  assert(v.pinRemedies !== null && v.pinRemedies.length === 2, "remedies ride");
  assert(v.pinRemedies[0] === remedyA, "ranked order preserved");
  assert(v.action === remedyA.humanCopy, `action ${v.action}`);
  assert(v.detail !== null, "shortfall copy expected");
  assert(
    v.detail.includes("12.00% edge target at $100.00") &&
      v.detail.includes("Pinned EV tops out at $375.43") &&
      v.detail.includes(`Smallest verified fix: ${remedyA.humanCopy}`) &&
      v.detail.includes("1 more verified option"),
    `detail ${v.detail}`,
  );
});

check("pins-infeasible with NO remedies: honest interlock copy", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: { kind: "pins-infeasible", detail: "Shortfall $8.72.", suggestion: "" },
    }),
  );
  assert(v.kind === "pins-infeasible", `kind ${v.kind}`);
  assert(
    v.pinRemedies !== null && v.pinRemedies.length === 0,
    "empty remedy list (never null) on a pins refusal",
  );
  assert(v.detail !== null && v.detail.includes("The pins interlock"), `detail ${v.detail}`);
  assert(
    v.action === "Unpin two or more cards, or rebuild the pin set.",
    `action ${v.action}`,
  );
});

check("pins-infeasible, ALL cards pinned: the verbatim-write CTA leads", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: { kind: "pins-infeasible", detail: "Shortfall $8.72.", suggestion: "" },
      pinsAllPinned: true,
      pinSweepComplete: true,
    }),
  );
  assert(v.kind === "pins-infeasible", `kind ${v.kind}`);
  assert(
    v.detail !== null &&
      v.detail.includes("Every card is pinned") &&
      /unpin two or more/i.test(v.detail) &&
      /approve edited pool/i.test(v.detail),
    `detail must carry the all-pinned + verbatim copy — got ${v.detail}`,
  );
  assert(
    v.action !== null && /approve edited pool/i.test(v.action),
    `action points at the verbatim write — got ${v.action}`,
  );
});

check("pins-infeasible, budget-cut sweep: no false 'every … was tried' claim", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      limit: { kind: "pins-infeasible", detail: "Shortfall $8.72.", suggestion: "" },
      pinSweepComplete: false,
    }),
  );
  assert(v.kind === "pins-infeasible", `kind ${v.kind}`);
  assert(
    v.detail !== null &&
      /solve budget/i.test(v.detail) &&
      !v.detail.includes("every raise, lower, unpin and in-budget price move was tried"),
    `detail must own the budget cut honestly — got ${v.detail}`,
  );
  assert(
    v.action === "Unpin two or more cards, or rebuild the pin set.",
    `action ${v.action}`,
  );
});

check("tag-contradiction outranks pins-infeasible", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      tagContradiction: "The staged pool cannot pay the %10 tag: no winner exists.",
      limit: { kind: "pins-infeasible", detail: "Shortfall.", suggestion: "" },
      pinRemedies: [remedyA],
    }),
  );
  assert(v.kind === "tag-contradiction", `kind ${v.kind}`);
  assert(
    v.headline === "The staged pool contradicts the pack's tag.",
    v.headline,
  );
  assert(
    v.detail === "The staged pool cannot pay the %10 tag: no winner exists.",
    `detail ${v.detail}`,
  );
  assert(v.pinRemedies === null, "remedies only ride the pins verdict");
});

// ── 4. LAW T surface on every kind ───────────────────────────────────────────

check("fitRange rides a write-assert refusal too", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      refusalCode: "tag-accuracy-miss",
      refusalMessage: "Missed the tag.",
      tagged: true,
      guidance: fitGuidance,
    }),
  );
  assert(v.kind === "refused", `kind ${v.kind}`);
  assert(v.fitProbed === true && v.fitRange !== null, "LAW T surface present");
});

check("fitRange rides a feasible off-nice plan", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      tagged: true,
      taggedAccuracyHit: true,
      allNice: false,
      guidance: fitGuidance,
    }),
  );
  assert(v.kind === "off-nice", `kind ${v.kind}`);
  assert(v.fitProbed === true && v.fitRange !== null, "LAW T surface present");
});

check("guidance without shapeFit: fitProbed false (probe never ran)", () => {
  const v = buildPackTuneVerdict(
    baseInput({
      feasible: false,
      refusalCode: "infeasible",
      refusalMessage: "Refused.",
      guidance: unprobedGuidance,
    }),
  );
  assert(v.fitProbed === false && v.fitRange === null, "no probe, no window");
});

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`Failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
