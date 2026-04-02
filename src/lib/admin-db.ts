import { PrismaClient } from "@/generated/admin-prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForAdminPrisma = globalThis as unknown as {
  adminPrisma: PrismaClient | undefined;
};

function createClient() {
  const adapter = new PrismaPg(
    {
      connectionString: process.env.ADMIN_DATABASE_URL,
      min: 0,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      maxLifetimeSeconds: 30,
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
  const msg = error.message;
  if (
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
