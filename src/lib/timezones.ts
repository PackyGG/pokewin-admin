// ---------------------------------------------------------------------------
// Curated IANA timezone list
// ---------------------------------------------------------------------------
//
// The full zone database has ~600 entries — overkill for the admin
// profile dropdown. This is a hand-picked subset covering the admin
// team's actual locations (Canada, Germany, Sweden) plus the major
// regions pokewin users come from. Sorted by continent then zone.
//
// Users who need something exotic can still type a custom IANA string
// in the profile editor — the validator uses Intl.DateTimeFormat which
// accepts any zone the runtime supports.
// ---------------------------------------------------------------------------

export type TimezoneEntry = {
  /** IANA id (e.g. "Europe/Berlin") — what we persist. */
  value: string;
  /** Human-friendly city name for the dropdown. */
  label: string;
};

export type TimezoneGroup = {
  region: string;
  zones: TimezoneEntry[];
};

export const TIMEZONE_GROUPS: TimezoneGroup[] = [
  {
    region: "Americas",
    zones: [
      { value: "America/Vancouver", label: "Vancouver" },
      { value: "America/Edmonton", label: "Edmonton" },
      { value: "America/Winnipeg", label: "Winnipeg" },
      { value: "America/Toronto", label: "Toronto" },
      { value: "America/Halifax", label: "Halifax" },
      { value: "America/St_Johns", label: "St. John's" },
      { value: "America/Los_Angeles", label: "Los Angeles" },
      { value: "America/Denver", label: "Denver" },
      { value: "America/Chicago", label: "Chicago" },
      { value: "America/New_York", label: "New York" },
      { value: "America/Phoenix", label: "Phoenix" },
      { value: "America/Anchorage", label: "Anchorage" },
      { value: "America/Mexico_City", label: "Mexico City" },
      { value: "America/Sao_Paulo", label: "Sao Paulo" },
      { value: "America/Buenos_Aires", label: "Buenos Aires" },
    ],
  },
  {
    region: "Europe",
    zones: [
      { value: "Europe/London", label: "London" },
      { value: "Europe/Dublin", label: "Dublin" },
      { value: "Europe/Lisbon", label: "Lisbon" },
      { value: "Europe/Madrid", label: "Madrid" },
      { value: "Europe/Paris", label: "Paris" },
      { value: "Europe/Amsterdam", label: "Amsterdam" },
      { value: "Europe/Brussels", label: "Brussels" },
      { value: "Europe/Zurich", label: "Zurich" },
      { value: "Europe/Berlin", label: "Berlin" },
      { value: "Europe/Vienna", label: "Vienna" },
      { value: "Europe/Rome", label: "Rome" },
      { value: "Europe/Copenhagen", label: "Copenhagen" },
      { value: "Europe/Oslo", label: "Oslo" },
      { value: "Europe/Stockholm", label: "Stockholm" },
      { value: "Europe/Helsinki", label: "Helsinki" },
      { value: "Europe/Warsaw", label: "Warsaw" },
      { value: "Europe/Prague", label: "Prague" },
      { value: "Europe/Athens", label: "Athens" },
      { value: "Europe/Istanbul", label: "Istanbul" },
      { value: "Europe/Moscow", label: "Moscow" },
    ],
  },
  {
    region: "Asia / Pacific",
    zones: [
      { value: "Asia/Dubai", label: "Dubai" },
      { value: "Asia/Kolkata", label: "Mumbai / Kolkata" },
      { value: "Asia/Bangkok", label: "Bangkok" },
      { value: "Asia/Singapore", label: "Singapore" },
      { value: "Asia/Hong_Kong", label: "Hong Kong" },
      { value: "Asia/Shanghai", label: "Shanghai" },
      { value: "Asia/Tokyo", label: "Tokyo" },
      { value: "Asia/Seoul", label: "Seoul" },
      { value: "Australia/Perth", label: "Perth" },
      { value: "Australia/Sydney", label: "Sydney" },
      { value: "Pacific/Auckland", label: "Auckland" },
    ],
  },
  {
    region: "Africa",
    zones: [
      { value: "Africa/Lagos", label: "Lagos" },
      { value: "Africa/Cairo", label: "Cairo" },
      { value: "Africa/Johannesburg", label: "Johannesburg" },
    ],
  },
  {
    region: "Universal",
    zones: [{ value: "UTC", label: "UTC (Coordinated Universal Time)" }],
  },
];

/** Flat list — handy for quick lookups by value. */
export const TIMEZONE_FLAT: TimezoneEntry[] = TIMEZONE_GROUPS.flatMap(
  (g) => g.zones,
);

/** Find the curated label for a stored IANA value. Returns the raw id if unknown. */
export function timezoneLabel(value: string): string {
  const hit = TIMEZONE_FLAT.find((z) => z.value === value);
  return hit ? `${hit.label} (${hit.value})` : value;
}

/**
 * Format a Date in the given zone as a short "HH:mm" clock — used by the
 * profile editor's current-time preview. Uses Intl directly so we don't
 * need date-fns for this 2-field render.
 */
export function formatClockInZone(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return "—";
  }
}
