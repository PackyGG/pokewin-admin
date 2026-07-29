import "server-only";

import { z } from "zod";

const fiatEmailCatchSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().trim().min(1).max(200),
  username: z.string().nullable(),
  depositIntentId: z.string().trim().min(1).max(200).nullable(),
  checkoutEmail: z.string(),
  domain: z.string(),
  riskType: z.enum([
    "blacklisted_domain",
    "gmail_dot_fragmentation",
    "suspicious_deposit_cluster",
  ]),
  source: z.enum(["whop_checkout", "signup"]),
  withdrawalsLocked: z.boolean(),
  occurredAt: z.string(),
});

const fiatEmailCatchListSchema = z.object({
  data: z.array(fiatEmailCatchSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    pages: z.number().int().positive(),
  }),
});

export type FiatEmailCatch = z.infer<typeof fiatEmailCatchSchema>;
export type FiatEmailCatchRiskType = FiatEmailCatch["riskType"];
export type FiatEmailCatchList = {
  data: FiatEmailCatch[];
  page: number;
  limit: number;
  total: number;
  pages: number;
};

export type FiatEmailCatchFilters = {
  page: number;
  limit: number;
  search?: string;
  riskType?: string;
  source?: string;
  lockStatus?: string;
};

const TIMEOUT_MS = 8_000;

function connection(): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function getFiatEmailCatches(
  filters: FiatEmailCatchFilters,
): Promise<FiatEmailCatchList> {
  const configured = connection();
  if (!configured) {
    throw new Error("The Antifraud monitor API is not configured.");
  }

  const searchParams = new URLSearchParams({
    page: String(
      Math.min(10_000, Math.max(1, Math.trunc(filters.page) || 1)),
    ),
    limit: String(
      Math.min(100, Math.max(1, Math.trunc(filters.limit) || 20)),
    ),
  });
  const search = filters.search?.trim().slice(0, 100);
  if (search) searchParams.set("search", search);
  if (
    filters.riskType === "blacklisted_domain" ||
    filters.riskType === "gmail_dot_fragmentation" ||
    filters.riskType === "suspicious_deposit_cluster"
  ) {
    searchParams.set("riskType", filters.riskType);
  }
  if (filters.source === "whop_checkout" || filters.source === "signup") {
    searchParams.set("source", filters.source);
  }
  if (filters.lockStatus === "locked" || filters.lockStatus === "pending") {
    searchParams.set("lockStatus", filters.lockStatus);
  }

  let response: Response;
  try {
    response = await fetch(
      `${configured.baseUrl}/v1/fiat-email-catches?${searchParams.toString()}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configured.token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The Antifraud monitor service did not respond.");
  }
  if (!response.ok) {
    throw new Error("Fraudulent fiat deposits could not be loaded.");
  }
  const payload = fiatEmailCatchListSchema.parse(await response.json());
  return {
    data: payload.data,
    ...payload.pagination,
  };
}

const fiatEmailCatchUserSchema = z.object({
  userId: z.string().trim().min(1).max(200),
  username: z.string().nullable(),
  catchCount: z.number().int().nonnegative(),
  caughtDepositCount: z.number().int().nonnegative(),
  riskTypes: z.array(
    z.enum([
      "blacklisted_domain",
      "gmail_dot_fragmentation",
      "suspicious_deposit_cluster",
    ]),
  ),
  sources: z.array(z.enum(["whop_checkout", "signup"])),
  emailCount: z.number().int().nonnegative(),
  latestEmail: z.string(),
  latestDomain: z.string(),
  latestDepositIntentId: z.string().trim().min(1).max(200).nullable(),
  withdrawalsLocked: z.boolean(),
  lastOccurredAt: z.string(),
});

const fiatEmailCatchUserListSchema = z.object({
  data: z.array(fiatEmailCatchUserSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    pages: z.number().int().positive(),
  }),
});

export type FiatEmailCatchUser = z.infer<typeof fiatEmailCatchUserSchema>;
export type FiatEmailCatchUserList = {
  data: FiatEmailCatchUser[];
  page: number;
  limit: number;
  total: number;
  pages: number;
};

export async function getFiatEmailCatchUsers(
  filters: FiatEmailCatchFilters,
): Promise<FiatEmailCatchUserList> {
  const configured = connection();
  if (!configured) {
    throw new Error("The Antifraud monitor API is not configured.");
  }

  const searchParams = new URLSearchParams({
    page: String(
      Math.min(10_000, Math.max(1, Math.trunc(filters.page) || 1)),
    ),
    limit: String(
      Math.min(100, Math.max(1, Math.trunc(filters.limit) || 20)),
    ),
  });
  const search = filters.search?.trim().slice(0, 100);
  if (search) searchParams.set("search", search);
  if (
    filters.riskType === "blacklisted_domain" ||
    filters.riskType === "gmail_dot_fragmentation" ||
    filters.riskType === "suspicious_deposit_cluster"
  ) {
    searchParams.set("riskType", filters.riskType);
  }
  if (filters.source === "whop_checkout" || filters.source === "signup") {
    searchParams.set("source", filters.source);
  }
  if (filters.lockStatus === "locked" || filters.lockStatus === "pending") {
    searchParams.set("lockStatus", filters.lockStatus);
  }

  let response: Response;
  try {
    response = await fetch(
      `${configured.baseUrl}/v1/fiat-email-catch-users?${searchParams.toString()}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configured.token}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    throw new Error("The Antifraud monitor service did not respond.");
  }
  if (!response.ok) {
    throw new Error("Fraudulent fiat deposit users could not be loaded.");
  }
  const payload = fiatEmailCatchUserListSchema.parse(await response.json());
  return {
    data: payload.data,
    ...payload.pagination,
  };
}
