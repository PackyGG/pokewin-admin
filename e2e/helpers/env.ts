import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader for the E2E suite. Playwright doesn't auto-load
 * dotenv files and we don't want a hard dependency on `dotenv` just for
 * this — parsing a KEY=VALUE file is 10 lines.
 *
 * Load order (later wins):
 *   1. .env
 *   2. .env.local
 *   3. .env.test
 *   4. .env.test.local
 *
 * process.env values that are already set are NEVER overwritten. CI can
 * inject secrets via the environment and they take precedence over any
 * committed file.
 */
export function loadEnvFiles(): void {
  const root = resolve(__dirname, "..", "..");
  const candidates = [".env", ".env.local", ".env.test", ".env.test.local"];

  for (const name of candidates) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
