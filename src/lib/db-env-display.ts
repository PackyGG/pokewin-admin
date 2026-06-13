import "server-only";

import {
  isDevDbConfigured,
  readDbEnvFromCookie,
} from "@/lib/db-env";
import {
  parseDbUrlDisplay,
  type MainDbEnvDisplay,
} from "@/lib/db-env-display.types";

export type { MainDbEnvDisplay } from "@/lib/db-env-display.types";

export async function getMainDbEnvDisplay(): Promise<MainDbEnvDisplay> {
  const activeEnv = await readDbEnvFromCookie();
  return {
    activeEnv,
    devConfigured: isDevDbConfigured(),
    dev: parseDbUrlDisplay(process.env.DEV_DATABASE_URL),
    devDatabaseUrl: process.env.DEV_DATABASE_URL?.trim() || null,
  };
}
