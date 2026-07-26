import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Main PostgreSQL introspection");
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
  out: "./src/lib/db-schema/main",
  schemaFilter: ["public"],
  introspect: { casing: "preserve" },
});
