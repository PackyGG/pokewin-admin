import { param, sql, type SQL } from "drizzle-orm";

/** Compile trusted PostgreSQL text with `$n` values into bound Drizzle SQL. */
export function positionalSql(
  query: string,
  values: readonly unknown[],
): SQL {
  const chunks: SQL[] = [];
  const used = new Set<number>();
  let rawStart = 0;
  let cursor = 0;

  const pushRawThrough = (end: number) => {
    if (end > rawStart) chunks.push(sql.raw(query.slice(rawStart, end)));
  };

  while (cursor < query.length) {
    const char = query[cursor];
    const next = query[cursor + 1];

    if (char === "'" || char === '"') {
      const quote = char;
      const escapeString =
        quote === "'" &&
        cursor > 0 &&
        query[cursor - 1]?.toLowerCase() === "e" &&
        (cursor < 2 || !/[A-Za-z0-9_$]/.test(query[cursor - 2] ?? ""));
      cursor += 1;
      let closed = false;
      while (cursor < query.length) {
        if (query[cursor] === quote) {
          if (query[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        if (
          escapeString &&
          query[cursor] === "\\" &&
          cursor + 1 < query.length
        ) {
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL quoted value");
      continue;
    }

    if (char === "-" && next === "-") {
      const newline = query.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? query.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      cursor += 2;
      while (cursor < query.length && depth > 0) {
        if (query[cursor] === "/" && query[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (query[cursor] === "*" && query[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) throw new Error("Unterminated SQL block comment");
      continue;
    }

    if (char !== "$") {
      cursor += 1;
      continue;
    }

    const canStartToken =
      cursor === 0 || !/[A-Za-z0-9_$]/.test(query[cursor - 1] ?? "");
    const dollarQuote = canStartToken
      ? query
          .slice(cursor)
          .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]
      : undefined;
    if (dollarQuote) {
      const end = query.indexOf(dollarQuote, cursor + dollarQuote.length);
      if (end === -1) throw new Error("Unterminated SQL dollar-quoted value");
      cursor = end + dollarQuote.length;
      continue;
    }

    const placeholder = canStartToken
      ? query.slice(cursor).match(/^\$([1-9][0-9]*)/)?.[0]
      : undefined;
    if (!placeholder) {
      cursor += 1;
      continue;
    }

    pushRawThrough(cursor);
    const position = Number(placeholder.slice(1));
    if (!Number.isSafeInteger(position)) {
      throw new Error(`Invalid SQL bind placeholder ${placeholder}`);
    }
    const index = position - 1;
    if (index >= values.length) {
      throw new Error(`Missing SQL bind value for ${placeholder}`);
    }
    // A positional placeholder must remain one driver parameter. Interpolating
    // an array directly makes Drizzle expand it into `($1, $2, ...)`, which
    // PostgreSQL cannot cast to `text[]`/`uuid[]`.
    chunks.push(sql`${param(values[index])}`);
    used.add(index);
    cursor += placeholder.length;
    rawStart = cursor;
  }

  pushRawThrough(query.length);
  if (used.size !== values.length) throw new Error("Unused SQL bind value");
  return sql.join(chunks, sql.raw(""));
}
