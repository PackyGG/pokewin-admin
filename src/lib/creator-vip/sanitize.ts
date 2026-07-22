/**
 * Operator-text sanitising for values that leave this system and get RENDERED
 * somewhere else — specifically, program names, which travel through the API
 * into a Discord message.
 *
 * ── THE ACTUAL THREAT ─────────────────────────────────────────────────────
 * It is NOT HTML/XSS. Discord doesn't render HTML, and every admin surface
 * here is React (which escapes by default). The real exposure is that a
 * program name is operator-influenced text that a bot pastes into a channel,
 * where it is interpreted as MARKDOWN and MENTIONS. A program named
 * `@everyone free money` pings a whole server; one containing
 * `](https://evil.tld)` closes a link the bot opened and re-points it.
 * Neither is caught by any HTML escaper, which is why escaping-on-output
 * would have been the wrong instinct here.
 *
 * Sanitising happens at WRITE time — one place, auditable, and the STORED
 * value is the safe one. Escaping on every read would mean a surface added
 * later, that forgets to, silently reintroduces the hole.
 *
 * Client-safe: no imports, so the create dialog can preview exactly what the
 * server will store.
 */

/**
 * Is this code point invisible, or capable of changing text direction?
 *
 * Expressed as a numeric check rather than a regex character class on purpose:
 * a class of literal control characters is unreadable in source and easy for
 * tooling to mangle, and the `\u`-escaped form is fragile to any pass that
 * rewrites the file. The ranges are:
 *
 *   0000–001F, 007F–009F  C0 / C1 control characters
 *   00AD                  soft hyphen (renders as nothing)
 *   200B–200F             zero-width space/joiner + LTR/RTL marks
 *   202A–202E             bidi embedding + OVERRIDE (text reversal)
 *   2060–2064             word joiner + invisible maths operators
 *   FEFF                  byte-order mark / zero-width no-break space
 *
 * These appear in attacks to make one string render as another — a label that
 * looks like "Refund" but isn't. None has a legitimate place in a typed label.
 */
function isInvisibleOrBidi(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x00ad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff
  );
}

/** Strip every invisible / bidi code point, keeping the rest intact. */
function stripInvisible(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isInvisibleOrBidi(cp)) continue;
    out += ch;
  }
  return out;
}

/** Mass-ping tokens. Case-insensitive, because Discord matches them that way. */
const MASS_MENTION = /@(everyone|here)/gi;

/** Discord's encoded mention forms: <@123>, <@!123>, <@&456>, <#789>. */
const ENCODED_USER_MENTION = /<@[!&]?\d+>/g;
const ENCODED_CHANNEL_MENTION = /<#\d+>/g;

/**
 * Markdown control characters. These are what let a value break OUT of the
 * sentence the bot wrapped it in — the `]` and `(` that end one link and
 * begin another, the backtick that opens a code span, the backslash that
 * escapes whatever follows.
 */
const MARKDOWN_CONTROLS = /[[\]()*_~`>|\\]/g;

/**
 * Make an operator-supplied label safe to paste into a Discord message.
 *
 * Returns the cleaned string. Callers validate length AFTER this runs —
 * sanitising can only ever shorten, never lengthen.
 */
export function sanitizeProgramName(input: string): string {
  return stripInvisible(input)
    // "@everyone" → "@ everyone": reads the same to a human, pings nobody.
    .replace(MASS_MENTION, "@ $1")
    // Plain words, not "[mention]" — the markdown pass below strips brackets,
    // so anything bracketed here would come out half-eaten.
    .replace(ENCODED_USER_MENTION, "mention")
    .replace(ENCODED_CHANNEL_MENTION, "channel")
    .replace(MARKDOWN_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when sanitising would change what the operator typed, ignoring plain
 * whitespace tidying. Lets the create dialog warn up front instead of
 * silently rewriting their input after they hit save.
 */
export function needsSanitizing(input: string): boolean {
  const whitespaceOnly = input.replace(/\s+/g, " ").trim();
  return sanitizeProgramName(input) !== whitespaceOnly;
}
