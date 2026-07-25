"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  ANTIFRAUD_TOGGLE_ROLES,
  setAntifraudAccessSetting,
  setAntifraudUserList,
  type AntifraudToggleRole,
} from "@/lib/antifraud/access";

/**
 * Workspace access administration — OWNER / ADMIN ONLY.
 *
 * Two layers, both stored in `admin_settings`:
 *   • per-ROLE toggles — "let every support user in"
 *   • per-USERNAME allow / deny — the individual override on top
 *
 * Owners and admins are in unconditionally and cannot be denied, so there is no
 * way to use this to lock the workspace's own administrators out.
 *
 * Every change is audited: an access grant is exactly the kind of thing that
 * needs to be explainable six months later.
 */

const toggleSchema = z.object({
  role: z.enum(ANTIFRAUD_TOGGLE_ROLES),
  enabled: z.boolean(),
});

export async function setAntifraudRoleAccess(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const { role, enabled } = parsed.data;

  await setAntifraudAccessSetting(
    role as AntifraudToggleRole,
    enabled,
    session.userId,
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_access_toggled",
    metadata: { role, enabled },
  });

  revalidatePath("/antifraud/settings");
  revalidatePath("/", "layout");
}

const listSchema = z.object({
  list: z.enum(["allowlist", "denylist"]),
  // One username per line or comma-separated — normalized server-side.
  usernames: z.string().max(2000, "That list is too long"),
});

export async function setAntifraudAccessList(input: unknown): Promise<void> {
  const session = await requireAntifraudManager();
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);

  const usernames = parsed.data.usernames
    .split(/[\n,]/)
    .map((u) => u.trim())
    .filter(Boolean);

  if (usernames.length > 100) {
    throw new Error("Keep the list under 100 usernames");
  }

  await setAntifraudUserList(parsed.data.list, usernames, session.userId);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_access_list_updated",
    metadata: { list: parsed.data.list, count: usernames.length },
  });

  revalidatePath("/antifraud/settings");
  revalidatePath("/", "layout");
}
