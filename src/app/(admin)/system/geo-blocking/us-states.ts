// US state / territory display names, keyed by the USPS 2-letter code — the
// ISO 3166-2:US subdivision code the game backend reads from MaxMind
// (`subdivisions[0].isoCode`) and stores as the `US-{CODE}` row in
// country_restrictions (see the backend's
// 0137_seed_us_state_country_restrictions.sql). Display-only: the stored key
// the toggle actions write stays the full `US-CA` code.

const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/** True for a `US-{STATE}` country_restrictions code (e.g. "US-CA"). */
export function isUsStateCode(code: string): boolean {
  return /^US-[A-Z]{2}$/.test(code);
}

/** Display name for a `US-{STATE}` code, falling back to the raw code. */
export function usStateName(code: string): string {
  const sub = code.startsWith("US-") ? code.slice(3) : code;
  return US_STATE_NAMES[sub] ?? code;
}
