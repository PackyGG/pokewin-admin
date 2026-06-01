/**
 * Client-safe CSV serialization helpers.
 *
 * Pure string building + Blob — NO server imports, NO third-party deps.
 * Used by the shared <ExportButton> (a client component) to turn the
 * `ExportSection[]` returned by a page's server export action into a
 * downloadable .csv file.
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
 * Escape a single CSV field per RFC 4180: wrap in double quotes when the
 * value contains a comma, double quote, CR or LF; double any internal
 * quotes. `null` / `undefined` render as an empty field. Numbers render
 * via String() so locale grouping never sneaks in (raw machine value —
 * the human-formatted version belongs in the UI, not the export).
 */
export function escapeCsvField(value: ExportCell): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "number" ? String(value) : value;
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

/**
 * Trigger a browser download of `csv` under `filename`. Client-only —
 * touches `document` / `Blob` / `URL`, so this must never run on the
 * server. Prepends a UTF-8 BOM so Excel opens non-ASCII (usernames,
 * country names) without mangling the encoding.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick so the click has a chance to start the
  // download before the object URL is torn down.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Total data-row count across every section (for the success toast). */
export function totalRowCount(sections: ExportSection[]): number {
  return sections.reduce((sum, s) => sum + s.rows.length, 0);
}
