"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { creatorsApi } from "@/lib/backend-api/creators";
import {
  testingApi,
  type ActiveCodeRow,
  type EndNowResult,
  type InjectWagerResult,
  type QuickCreateLeaderboardResult,
} from "@/lib/backend-api/testing";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { BackendApiError } from "@/lib/backend-api/errors";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { requirePageAccess } from "@/lib/dal";

const PAGE_KEY = "/test/creator";

type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string };

function toErrorMessage(err: unknown): string {
  if (err instanceof BackendApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

/**
 * Refuse to call the testing endpoints unless the admin is currently
 * routed to the dev environment. This is the same gate the sidebar uses
 * to hide the page — duplicated at the action layer because a malicious
 * client could still POST directly to the server action without the
 * page render path.
 */
async function requireDevEnv(): Promise<ActionResult | null> {
  const dbEnv = await readDbEnvFromCookie();
  if (dbEnv !== "dev") {
    return {
      success: false,
      error:
        "Testing tools are only available while the dev environment is selected.",
    };
  }
  return null;
}

const setActiveCodeSchema = z.object({
  user_id: z.string().min(1),
  code: z.string().min(1).max(64).nullable(),
});

const quickCreateSchema = z.object({
  creator_user_id: z.string().min(1),
  affiliate_codes: z.array(z.string().min(1)).min(1),
  title: z.string().min(1).max(20).optional(),
  site_bonus_usd: z.number().positive().optional(),
  duration_hours: z.number().int().min(1).max(24 * 30).optional(),
});

const idSchema = z.string().uuid();

const injectWagerSchema = z.object({
  referred_user_id: z.string().min(1),
  code: z.string().min(1).max(64),
  wager_amount_usd: z.number().positive().max(1_000_000),
});

const promoteSchema = z.object({
  user_id: z.string().min(1),
  promote: z.boolean(),
});

export async function getActiveCodeAction(
  userId: string,
): Promise<ActionResult<ActiveCodeRow>> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  try {
    const data = await testingApi.getActiveCode(userId);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function setActiveCodeAction(
  input: z.infer<typeof setActiveCodeSchema>,
): Promise<ActionResult<ActiveCodeRow>> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = setActiveCodeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const data = await testingApi.setActiveCode(parsed.data.user_id, parsed.data.code);
    revalidatePath(PAGE_KEY);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function quickCreateLeaderboardAction(
  input: z.infer<typeof quickCreateSchema>,
): Promise<ActionResult<QuickCreateLeaderboardResult>> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = quickCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const data = await testingApi.quickCreateLeaderboard(parsed.data);
    revalidatePath(PAGE_KEY);
    revalidatePath("/creators/leaderboards");
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function endLeaderboardNowAction(
  id: string,
): Promise<ActionResult<EndNowResult>> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { success: false, error: "Invalid leaderboard id" };
  }

  try {
    const data = await testingApi.endLeaderboardNow(parsed.data);
    revalidatePath(PAGE_KEY);
    revalidatePath("/creators/leaderboards");
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function injectWagerAction(
  input: z.infer<typeof injectWagerSchema>,
): Promise<ActionResult<InjectWagerResult>> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = injectWagerSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const data = await testingApi.injectWager(parsed.data);
    revalidatePath(PAGE_KEY);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function setCreatorRoleAction(
  input: z.infer<typeof promoteSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = promoteSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    if (parsed.data.promote) {
      await creatorsApi.promote(parsed.data.user_id);
    } else {
      await creatorsApi.demote(parsed.data.user_id);
    }
    revalidatePath(PAGE_KEY);
    return { success: true };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function listActiveLeaderboardsAction(): Promise<
  ActionResult<
    Array<{
      id: string;
      title: string;
      creator_user_id: string;
      affiliate_codes: string[];
      time_status: "upcoming" | "active" | "ended";
      end_date: string;
      start_date: string;
    }>
  >
> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  try {
    const result = await affiliateLeaderboardsApi.list({
      status: "approved",
      limit: 50,
      offset: 0,
    });
    const rows = result.leaderboards
      .filter((lb) => lb.time_status !== "ended")
      .map((lb) => ({
        id: lb.id,
        title: lb.title,
        creator_user_id: lb.creator_user_id,
        affiliate_codes: lb.affiliate_codes,
        time_status: lb.time_status,
        end_date: lb.end_date,
        start_date: lb.start_date,
      }));
    return { success: true, data: rows };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

const forceEndSessionSchema = z.object({
  user_id: z.string().min(1),
  session_id: z.string().uuid(),
});

export async function forceEndSessionAction(
  input: z.infer<typeof forceEndSessionSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  const parsed = forceEndSessionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await creatorsApi.forceEndSession(parsed.data.user_id, parsed.data.session_id, {
      reason: "Force-ended via creator testing tools",
    });
    revalidatePath(PAGE_KEY);
    return { success: true };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}

export async function searchCreatorsAction(query: string): Promise<
  ActionResult<
    Array<{ user_id: string; username: string | null; email: string | null }>
  >
> {
  await requirePageAccess(PAGE_KEY);
  const guard = await requireDevEnv();
  if (guard) return guard;

  try {
    const result = await creatorsApi.list({
      search: query.trim() || undefined,
      offset: 0,
      limit: 25,
    });
    return {
      success: true,
      data: result.data.map((c) => ({
        user_id: c.id,
        username: c.username,
        email: c.email,
      })),
    };
  } catch (err) {
    return { success: false, error: toErrorMessage(err) };
  }
}
