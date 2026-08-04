const DISCORD_ACTION_ROW = 1;
const DISCORD_BUTTON = 2;
const DISCORD_LINK_BUTTON = 5;
const MAX_ACTION_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;

function safeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function rowButtons(
  row: Record<string, unknown>,
): Array<Record<string, unknown>> | null {
  if (row.type !== DISCORD_ACTION_ROW || !Array.isArray(row.components)) {
    return null;
  }

  return row.components.every(
    (component) =>
      typeof component === "object" &&
      component !== null &&
      !Array.isArray(component),
  )
    ? (row.components as Array<Record<string, unknown>>)
    : null;
}

/**
 * Adds a universal link button whenever an embed has a usable destination URL.
 * Producer-specific buttons are preserved, and an existing button to the same
 * destination wins so messages never render duplicate actions.
 */
export function ensureDiscordLinkButton(
  embed: Record<string, unknown>,
  components: readonly Record<string, unknown>[] = [],
): Array<Record<string, unknown>> {
  const destination = safeLinkUrl(embed.url);
  if (!destination) return [...components];

  for (const row of components) {
    const buttons = rowButtons(row);
    if (
      buttons?.some(
        (button) =>
          button.type === DISCORD_BUTTON &&
          button.style === DISCORD_LINK_BUTTON &&
          safeLinkUrl(button.url) === destination,
      )
    ) {
      return [...components];
    }
  }

  const linkButton = {
    type: DISCORD_BUTTON,
    style: DISCORD_LINK_BUTTON,
    label: "View details",
    url: destination,
  };
  const rows = components.map((row) => ({ ...row }));
  const availableRowIndex = rows.findIndex((row) => {
    const buttons = rowButtons(row);
    return buttons !== null && buttons.length < MAX_BUTTONS_PER_ROW;
  });

  if (availableRowIndex >= 0) {
    const buttons = rowButtons(rows[availableRowIndex]);
    rows[availableRowIndex] = {
      ...rows[availableRowIndex],
      components: [...(buttons ?? []), linkButton],
    };
    return rows;
  }

  if (rows.length < MAX_ACTION_ROWS) {
    rows.push({ type: DISCORD_ACTION_ROW, components: [linkButton] });
  }

  return rows;
}
