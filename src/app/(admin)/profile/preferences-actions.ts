"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { verifySession } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  DATE_FORMAT_VALUES,
  THEME_VALUES,
  isValidTimezone,
  setAdminPreferences,
  type AdminPreferences,
} from "@/lib/admin-preferences";

// ---------------------------------------------------------------------------
// Preferences server action
// ---------------------------------------------------------------------------
//
// Lives in its own file so it doesn't collide with the existing profile
// actions (display_username + avatar). Called from:
//   • the header profile dropdown (theme / timezone quick-pick)
//   • the /profile preferences editor (full form save)
// Each field is optional so a dropdown tweak doesn't need to ship the
// whole blob.
// ---------------------------------------------------------------------------

const preferencesSchema = z
  .object({
    theme: z.enum(THEME_VALUES as readonly [string, ...string[]]).optional(),
    // `null` = clear the explicit preference → use browser-detected zone.
    timezone: z
      .union([z.string().min(1).max(64), z.null()])
      .optional()
      .refine(
        (v) => v === undefined || v === null || isValidTimezone(v),
        "Unknown timezone",
      ),
    dateFormat: z
      .enum(DATE_FORMAT_VALUES as readonly [string, ...string[]])
      .optional(),
  })
  .refine(
    (v) =>
      v.theme !== undefined ||
      v.timezone !== undefined ||
      v.dateFormat !== undefined,
    "Nothing to update",
  );

/**
 * Persist one or more preference fields for the current admin. The theme
 * is also applied client-side by next-themes — this action just records
 * the choice so it survives logout / other devices.
 */
export async function updatePreferences(
  input: Partial<AdminPreferences>,
): Promise<void> {
  const session = await verifySession();

  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  // Zod's `.enum()` returns a widened string — cast back to the narrow
  // union types the helper expects. Valid values are guaranteed by the
  // schema; the cast is a type-level assertion.
  await setAdminPreferences(session.userId, {
    ...(parsed.data.theme !== undefined
      ? { theme: parsed.data.theme as AdminPreferences["theme"] }
      : {}),
    ...(parsed.data.timezone !== undefined
      ? { timezone: parsed.data.timezone }
      : {}),
    ...(parsed.data.dateFormat !== undefined
      ? {
          dateFormat: parsed.data
            .dateFormat as NonNullable<AdminPreferences["dateFormat"]>,
        }
      : {}),
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_preferences_updated",
    metadata: {
      themeUpdated: parsed.data.theme !== undefined,
      timezoneUpdated: parsed.data.timezone !== undefined,
      dateFormatUpdated: parsed.data.dateFormat !== undefined,
    },
  });

  // Preferences drive the TimezoneProvider in the admin layout, so bust
  // the layout so other tabs / hard navigations pick up the change.
  revalidatePath("/", "layout");
}
