import type { Databases } from "./db.js";

export type RiskyLocationPolicy = {
  countryCode: string;
  monitorDurationSeconds: number;
};

type RiskyLocationRow = {
  country_code: string;
  monitor_duration_seconds: number;
};

const CACHE_TTL_MS = 30_000;

export function normalizeCountryCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export class RiskyLocationStore {
  private cache: { loadedAt: number; policies: Map<string, RiskyLocationPolicy> } | null =
    null;

  constructor(private readonly db: Databases) {}

  invalidate(): void {
    this.cache = null;
  }

  async forCountry(
    countryCode: string | null | undefined,
  ): Promise<RiskyLocationPolicy | null> {
    const normalized = normalizeCountryCode(countryCode);
    if (!normalized) return null;

    const policies = await this.getPolicies();
    return policies.get(normalized) ?? null;
  }

  private async getPolicies(): Promise<Map<string, RiskyLocationPolicy>> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_TTL_MS) {
      return this.cache.policies;
    }

    const result = await this.db.antifraud.query<RiskyLocationRow>(
      `
        SELECT country_code, monitor_duration_seconds
        FROM risky_locations
        WHERE enabled
      `,
    );
    const policies = new Map(
      result.rows.map((row) => [
        row.country_code,
        {
          countryCode: row.country_code,
          monitorDurationSeconds: row.monitor_duration_seconds,
        },
      ]),
    );
    this.cache = { loadedAt: Date.now(), policies };
    return policies;
  }
}
