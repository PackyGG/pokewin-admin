/**
 * Fetch the backend's admin-gated OpenAPI spec and generate TypeScript
 * types for pokewin-admin.
 *
 * Run: bun run generate:api
 *
 * Env:
 *   API_DOCS_URL        required — full URL to the admin docs json
 *   ADMIN_API_KEY       required — sent as x-api-key
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   optional CF Access
 */

import dotenv from "dotenv";
import { execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

dotenv.config({ path: ".env.local" });
dotenv.config();

const API_DOCS_URL =
  process.env.API_DOCS_URL || "https://dev.fdsfi.com/v1/admin/docs/json";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const OUTPUT_DIR = join(process.cwd(), "src/lib/backend-api/generated");
const TYPES_FILE = join(OUTPUT_DIR, "types.ts");
const SPEC_FILE = join(OUTPUT_DIR, "openapi.json");

async function generateApiTypes() {
  if (!ADMIN_API_KEY) {
    throw new Error("ADMIN_API_KEY is required");
  }

  console.log(`📡 Fetching admin spec from ${API_DOCS_URL}...`);

  const headers: Record<string, string> = { "x-api-key": ADMIN_API_KEY };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  }

  const response = await fetch(API_DOCS_URL, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch admin spec: ${response.status} ${response.statusText}`,
    );
  }

  const openApiSpec = await response.json();

  // Fix malformed parameter schemas (string instead of SchemaObject) —
  // same defensive cleanup the frontend script does.
  if (openApiSpec.paths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [, pathItem] of Object.entries(openApiSpec.paths) as any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const method of Object.values(pathItem) as any) {
        if (method?.parameters) {
          for (const param of method.parameters) {
            if (typeof param.schema === "string") {
              param.schema = { type: param.schema };
            }
          }
        }
      }
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  await writeFile(SPEC_FILE, JSON.stringify(openApiSpec, null, 2));
  console.log(`✓ Saved OpenAPI spec to ${SPEC_FILE}`);

  console.log("🔨 Generating TypeScript types...");
  execSync(`npx openapi-typescript "${SPEC_FILE}" -o "${TYPES_FILE}"`, {
    stdio: "inherit",
  });
  console.log(`✓ Generated types to ${TYPES_FILE}`);

  console.log("\n✅ API types generated successfully!");
}

generateApiTypes().catch((err) => {
  console.error("❌ Error generating API types:", err);
  process.exit(1);
});
