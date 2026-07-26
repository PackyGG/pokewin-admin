import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.ADMIN_DATABASE_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL is required for Admin PostgreSQL introspection",
  );
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: process.env.ADMIN_DATABASE_URL },
  out: "./src/lib/db-schema/admin",
  schemaFilter: ["public"],
  introspect: { casing: "preserve" },
});
