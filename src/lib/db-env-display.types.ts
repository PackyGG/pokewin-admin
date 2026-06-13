export type DbEnv = "prod" | "dev";

export type DbTargetDisplay = {
  configured: boolean;
  host: string | null;
  port: string | null;
  database: string | null;
};

export type MainDbEnvDisplay = {
  activeEnv: DbEnv;
  devConfigured: boolean;
  dev: DbTargetDisplay;
  /** Full dev URL — admin-only UI; never log or commit. Prod is never exposed. */
  devDatabaseUrl: string | null;
};

export function formatDbTargetLine(target: DbTargetDisplay): string {
  if (!target.configured) return "Not configured";
  const parts = [target.host, target.port !== "5432" ? target.port : null, target.database]
    .filter(Boolean)
    .join(" · ");
  return parts || "Configured";
}

/** Parse a Postgres URL for display — never returns credentials. */
export function parseDbUrlDisplay(
  connectionString: string | undefined,
): DbTargetDisplay {
  if (!connectionString?.trim()) {
    return { configured: false, host: null, port: null, database: null };
  }
  try {
    const normalized = connectionString
      .trim()
      .replace(/^postgresql:\/\//i, "https://")
      .replace(/^postgres:\/\//i, "https://");
    const parsed = new URL(normalized);
    return {
      configured: true,
      host: parsed.hostname || null,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || null,
    };
  } catch {
    return { configured: true, host: null, port: null, database: null };
  }
}
