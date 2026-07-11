import { NextResponse } from "next/server";
import { z } from "zod";
import {
  planPackTune,
  type PackTuneStagedInput,
} from "../../doctor/retune-actions";

/**
 * POST /pack-studio/retune/plan — the workspace's READ-ONLY plan transport.
 *
 * A route handler, deliberately NOT a server action: React serializes server
 * actions per client (one at a time, in dispatch order), so one slow plan —
 * the post-push fresh re-plan, a refused staged pool running the ±60% probe —
 * queued EVERY later pool/plan/pre-flight call behind it. That was the
 * owner's "pushed a pack, the next one takes minutes or never loads (until a
 * reload clears the queue)" incident. Route handlers run concurrently; the
 * workspace's seq-guards (one in-flight plan + one pre-flight per pack)
 * bound the parallelism, and `planPackTune` reads MAIN before the CPU-bound
 * solve, so the max:3 PG pool is never held across a solve.
 *
 * Auth runs INSIDE `planPackTune` (`requireRetuneOwner` — throws, never
 * redirects) exactly as it does for the action path; a denial surfaces as
 * 403 JSON. Refusals stay DATA in the plan payload (never an HTTP error).
 */

const stagedSchema = z.object({
  cards: z
    .array(z.object({ cardId: z.string().min(1), order: z.number().int() }))
    .max(500),
  price: z.number().finite().positive().optional(),
  pinPrice: z.boolean().optional(),
  pinnedOdds: z
    .array(z.object({ cardId: z.string().min(1), pct: z.number().finite() }))
    .max(500)
    .optional(),
  tagOverride: z
    .union([
      z.object({ kind: z.literal("untag") }),
      z.object({
        kind: z.literal("tag"),
        tag: z.enum(["pct1", "pct5", "pct10", "fifty50"]),
        hitRate: z.number().finite(),
      }),
    ])
    .optional(),
  edgeTargetOverride: z.number().finite().optional(),
});

const bodySchema = z.object({
  packId: z.string().min(1),
  staged: stagedSchema.nullish(),
  opts: z
    .object({
      fresh: z.boolean().optional(),
      lite: z.boolean().optional(),
    })
    .nullish(),
});

export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid plan request." },
      { status: 400 },
    );
  }
  const { packId, staged, opts } = parsed.data;
  try {
    const plan = await planPackTune(
      packId,
      (staged ?? null) as PackTuneStagedInput | null,
      opts ?? null,
    );
    return NextResponse.json({ plan });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Planning failed unexpectedly.";
    const status = /not authorized|restricted to authorized/i.test(message)
      ? 403
      : /invalid pack id/i.test(message)
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
