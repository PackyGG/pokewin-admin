import "server-only";

export { sql } from "drizzle-orm";
export type { SQL } from "drizzle-orm";

export {
  drizzleForEnv,
  getDevDrizzleDb,
  getDrizzleDb,
  getProdDrizzleDb,
} from "@/lib/db";
export type { MainDrizzleDb } from "@/lib/db";

export { adminDrizzle } from "@/lib/admin-db";
export type { AdminDrizzleDb } from "@/lib/admin-db";
