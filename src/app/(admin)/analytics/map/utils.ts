import type { AccentColor } from "@/components/modern-panels";
import type { CountryUserCount } from "@/lib/queries/map";

/**
 * Map-page helpers — pure, framework-agnostic. Kept co-located with the
 * route so they're easy to reason about.
 */

export type MapMetric = "users" | "deposits" | "wagers" | "multiplier";

export const MAP_METRICS: readonly MapMetric[] = [
  "users",
  "deposits",
  "wagers",
  "multiplier",
] as const;

export const METRIC_META: Record<
  MapMetric,
  { label: string; short: string; accent: AccentColor; format: "number" | "currency" | "multiplier" }
> = {
  users: { label: "Users", short: "Users", accent: "blue", format: "number" },
  deposits: { label: "Deposits", short: "Deposits", accent: "emerald", format: "currency" },
  wagers: { label: "Total Wagers", short: "Wagers", accent: "cyan", format: "currency" },
  multiplier: {
    label: "Wager / Deposit",
    short: "Multiplier",
    accent: "amber",
    format: "multiplier",
  },
};

export function parseMetric(value: string | undefined): MapMetric {
  if (value && (MAP_METRICS as readonly string[]).includes(value)) {
    return value as MapMetric;
  }
  return "users";
}

/**
 * Select the metric value from a country row. Multiplier is derived — a
 * country with no deposits returns 0 so it still sorts naturally.
 */
export function metricValue(entry: CountryUserCount, metric: MapMetric): number {
  switch (metric) {
    case "users":
      return entry.user_count;
    case "deposits":
      return entry.total_deposits;
    case "wagers":
      return entry.total_wager;
    case "multiplier":
      return entry.total_deposits > 0 ? entry.total_wager / entry.total_deposits : 0;
  }
}

/**
 * ISO 3166-1 alpha-2 → flag emoji. Uses Unicode regional-indicator
 * offsets (A = 0x1F1E6). Standard technique — no library needed.
 * Returns empty string for invalid input.
 */
export function flagEmoji(alpha2: string): string {
  if (!alpha2 || alpha2.length !== 2) return "";
  const upper = alpha2.toUpperCase();
  const a = upper.charCodeAt(0);
  const b = upper.charCodeAt(1);
  // A-Z → 0x1F1E6 - 0x1F1FF
  if (a < 65 || a > 90 || b < 65 || b > 90) return "";
  return (
    String.fromCodePoint(0x1f1e6 + (a - 65)) +
    String.fromCodePoint(0x1f1e6 + (b - 65))
  );
}

/**
 * ISO 3166-1 alpha-2 → continent.
 *
 * This is a conservative mapping covering the alpha-2 codes that actually
 * appear in the database's `country_code` column (a standard 2-letter
 * ISO set). Used only to aggregate the per-country rows into continent
 * slices for the breakdown chart — a country missing from this map will
 * be bucketed as "Other" and still counted in totals.
 */
export type Continent = "Africa" | "Americas" | "Asia" | "Europe" | "Oceania" | "Other";

export const CONTINENT_ORDER: readonly Continent[] = [
  "Americas",
  "Europe",
  "Asia",
  "Oceania",
  "Africa",
  "Other",
] as const;

export const CONTINENT_COLORS: Record<Continent, string> = {
  Americas: "var(--chart-1)",
  Europe: "var(--chart-2)",
  Asia: "var(--chart-3)",
  Oceania: "var(--chart-4)",
  Africa: "var(--chart-5)",
  Other: "oklch(0.55 0.01 250)",
};

const CONTINENT_MAP: Record<string, Continent> = {
  // Americas
  US: "Americas", CA: "Americas", MX: "Americas", BR: "Americas", AR: "Americas",
  CL: "Americas", CO: "Americas", PE: "Americas", VE: "Americas", EC: "Americas",
  BO: "Americas", PY: "Americas", UY: "Americas", GY: "Americas", SR: "Americas",
  GF: "Americas", CR: "Americas", PA: "Americas", GT: "Americas", HN: "Americas",
  NI: "Americas", SV: "Americas", BZ: "Americas", CU: "Americas", DO: "Americas",
  HT: "Americas", JM: "Americas", PR: "Americas", TT: "Americas", BS: "Americas",
  BB: "Americas", GD: "Americas", LC: "Americas", VC: "Americas", AG: "Americas",
  DM: "Americas", KN: "Americas", AW: "Americas", CW: "Americas", BM: "Americas",
  GL: "Americas", KY: "Americas", TC: "Americas", VI: "Americas", VG: "Americas",
  AI: "Americas", MS: "Americas", PM: "Americas", FK: "Americas",
  // Europe
  GB: "Europe", IE: "Europe", FR: "Europe", DE: "Europe", ES: "Europe",
  PT: "Europe", IT: "Europe", NL: "Europe", BE: "Europe", LU: "Europe",
  CH: "Europe", AT: "Europe", LI: "Europe", DK: "Europe", SE: "Europe",
  NO: "Europe", FI: "Europe", IS: "Europe", PL: "Europe", CZ: "Europe",
  SK: "Europe", HU: "Europe", SI: "Europe", HR: "Europe", BA: "Europe",
  RS: "Europe", ME: "Europe", MK: "Europe", AL: "Europe", XK: "Europe",
  GR: "Europe", BG: "Europe", RO: "Europe", MD: "Europe", UA: "Europe",
  BY: "Europe", LT: "Europe", LV: "Europe", EE: "Europe", RU: "Europe",
  MT: "Europe", CY: "Europe", AD: "Europe", MC: "Europe", SM: "Europe",
  VA: "Europe", GI: "Europe", FO: "Europe", AX: "Europe", JE: "Europe",
  GG: "Europe", IM: "Europe",
  // Asia
  CN: "Asia", JP: "Asia", KR: "Asia", KP: "Asia", TW: "Asia",
  HK: "Asia", MO: "Asia", MN: "Asia", IN: "Asia", PK: "Asia",
  BD: "Asia", LK: "Asia", NP: "Asia", BT: "Asia", MV: "Asia",
  AF: "Asia", IR: "Asia", IQ: "Asia", SY: "Asia", LB: "Asia",
  JO: "Asia", IL: "Asia", PS: "Asia", SA: "Asia", YE: "Asia",
  OM: "Asia", AE: "Asia", QA: "Asia", BH: "Asia", KW: "Asia",
  TR: "Asia", GE: "Asia", AM: "Asia", AZ: "Asia", KZ: "Asia",
  UZ: "Asia", TM: "Asia", TJ: "Asia", KG: "Asia", TH: "Asia",
  VN: "Asia", LA: "Asia", KH: "Asia", MM: "Asia", MY: "Asia",
  SG: "Asia", ID: "Asia", PH: "Asia", BN: "Asia", TL: "Asia",
  // Oceania
  AU: "Oceania", NZ: "Oceania", PG: "Oceania", FJ: "Oceania", SB: "Oceania",
  VU: "Oceania", NC: "Oceania", PF: "Oceania", WS: "Oceania", TO: "Oceania",
  KI: "Oceania", TV: "Oceania", NR: "Oceania", PW: "Oceania", MH: "Oceania",
  FM: "Oceania", CK: "Oceania", NU: "Oceania", GU: "Oceania", MP: "Oceania",
  AS: "Oceania",
  // Africa
  EG: "Africa", LY: "Africa", TN: "Africa", DZ: "Africa", MA: "Africa",
  SD: "Africa", SS: "Africa", ET: "Africa", ER: "Africa", DJ: "Africa",
  SO: "Africa", KE: "Africa", UG: "Africa", RW: "Africa", BI: "Africa",
  TZ: "Africa", MG: "Africa", MU: "Africa", SC: "Africa", KM: "Africa",
  MZ: "Africa", MW: "Africa", ZM: "Africa", ZW: "Africa", BW: "Africa",
  NA: "Africa", ZA: "Africa", LS: "Africa", SZ: "Africa", AO: "Africa",
  CD: "Africa", CG: "Africa", GA: "Africa", GQ: "Africa", CM: "Africa",
  CF: "Africa", TD: "Africa", NE: "Africa", NG: "Africa", BJ: "Africa",
  TG: "Africa", GH: "Africa", CI: "Africa", LR: "Africa", SL: "Africa",
  GN: "Africa", GW: "Africa", SN: "Africa", GM: "Africa", ML: "Africa",
  BF: "Africa", MR: "Africa", CV: "Africa", ST: "Africa", RE: "Africa",
  YT: "Africa", EH: "Africa",
};

export function continentFor(alpha2: string): Continent {
  return CONTINENT_MAP[alpha2.toUpperCase()] ?? "Other";
}
