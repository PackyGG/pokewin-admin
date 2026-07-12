import { PrismaClient } from "@/generated/admin-prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForAdminPrisma = globalThis as unknown as {
  adminPrisma: PrismaClient | undefined;
};

function createClient() {
  const adapter = new PrismaPg(
    {
      // Prefer a managed-pooler URL when set, else the direct URL (safe drop-in
      // fallback). Keep ADMIN_DATABASE_URL pointing at the DIRECT endpoint so
      // the Prisma CLI (`db push`/`db execute`, which the admin DB uses) keeps
      // working; ADMIN_DATABASE_URL_POOLED only routes the runtime adapter.
      connectionString:
        process.env.ADMIN_DATABASE_URL_POOLED ?? process.env.ADMIN_DATABASE_URL,
      min: 0,
      // Serverless: EVERY warm lambda holds its own pool against the same
      // small admin Postgres — a concurrent plan burst at max 5 exhausted
      // max_connections ("sorry, too many clients already", live incident
      // 2026-07-12) and auth died first. One Vercel lambda serves one
      // request; 2 covers intra-request Promise.all fan-out while keeping
      // the fleet-wide ceiling ~2×instances. Local dev/build keeps 5.
      max: process.env.VERCEL ? 2 : 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      maxLifetimeSeconds: 600,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      allowExitOnIdle: true,
    },
    {
      onPoolError: (err) =>
        console.error("[admin-db] Pool error:", err.message),
    },
  );

  return new PrismaClient({ adapter }).$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await query(args);
          } catch (error) {
            if (attempt < MAX_RETRIES && isConnectionError(error)) {
              const delay = attempt === 0 ? 100 : 500;
              console.warn(
                `[admin-db] Connection error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms...`,
              );
              await new Promise((r) => setTimeout(r, delay));
              continue;
            }
            throw error;
          }
        }
      },
    },
  }) as unknown as PrismaClient;
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code === "P1017" || code === "P1001" || code === "P2024") return true;
  // Postgres 53300 too_many_connections: the failure happens BEFORE any
  // query runs, so the backoff-retry is always safe — by the second attempt
  // another lambda's idle connections have usually been reaped.
  if (code === "53300") return true;
  const msg = error.message;
  if (
    msg.includes("too many clients") ||
    msg.includes("too many connections") ||
    msg.includes("Connection terminated") ||
    msg.includes("terminated unexpectedly") ||
    msg.includes("connection lost") ||
    msg.includes("Client has encountered a connection error") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("connection timeout")
  )
    return true;
  if (error.cause instanceof Error) return isConnectionError(error.cause);
  return false;
}

export const adminDb = globalForAdminPrisma.adminPrisma ?? createClient();

if (process.env.NODE_ENV !== "production")
  globalForAdminPrisma.adminPrisma = adminDb;
