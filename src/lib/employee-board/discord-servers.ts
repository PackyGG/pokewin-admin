import "server-only";

import { adminDb } from "@/lib/admin-db";

// Typed raw-SQL wrappers for the discord-server section of the
// employee board. These tables (employee_discord_servers +
// employee_discord_server_placements) are provisioned via the
// IF-NOT-EXISTS pattern in ensure-schema.ts and are NOT in the Prisma
// admin schema, so all access goes through here using tagged-template
// raw SQL (Prisma escapes the parameters; we never interpolate
// untrusted input). Every query select-lists the columns we need so
// no extra data leaks across the RSC boundary.

export type DiscordServerRow = {
  id: string;
  name: string;
  position: number;
};

export type DiscordPlacementRow = {
  id: string;
  employee_id: string;
  discord_server_id: string;
  roles: string[];
  position: number;
};

// ── Servers ─────────────────────────────────────────────────────────

export async function listDiscordServers(): Promise<DiscordServerRow[]> {
  const rows = await adminDb.$queryRaw<DiscordServerRow[]>`
    SELECT id::text       AS id,
           name,
           position
      FROM "employee_discord_servers"
     ORDER BY position ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: Number(r.position),
  }));
}

export async function findDiscordServerById(
  id: string,
): Promise<{ id: string } | null> {
  const rows = await adminDb.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM "employee_discord_servers"
     WHERE id = ${id}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLastDiscordServerPosition(): Promise<number> {
  const rows = await adminDb.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(position)::int AS max
      FROM "employee_discord_servers"
  `;
  const max = rows[0]?.max;
  return max === null || max === undefined ? -1 : Number(max);
}

export async function insertDiscordServer(
  name: string,
  position: number,
): Promise<{ id: string }> {
  const rows = await adminDb.$queryRaw<{ id: string }[]>`
    INSERT INTO "employee_discord_servers" ("name", "position")
    VALUES (${name}, ${position})
    RETURNING id::text AS id
  `;
  if (!rows[0]) throw new Error("Insert failed");
  return rows[0];
}

export async function updateDiscordServerName(
  id: string,
  name: string,
): Promise<boolean> {
  const result = await adminDb.$executeRaw`
    UPDATE "employee_discord_servers"
       SET name = ${name},
           updated_at = now()
     WHERE id = ${id}::uuid
  `;
  return Number(result) > 0;
}

export async function deleteDiscordServer(id: string): Promise<boolean> {
  // Placement rows CASCADE — see ensure-schema.ts.
  const result = await adminDb.$executeRaw`
    DELETE FROM "employee_discord_servers"
     WHERE id = ${id}::uuid
  `;
  return Number(result) > 0;
}

// ── Placements ──────────────────────────────────────────────────────

export async function listDiscordPlacements(): Promise<DiscordPlacementRow[]> {
  const rows = await adminDb.$queryRaw<DiscordPlacementRow[]>`
    SELECT id::text                  AS id,
           employee_id::text         AS employee_id,
           discord_server_id::text   AS discord_server_id,
           roles,
           position
      FROM "employee_discord_server_placements"
     ORDER BY position ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    employee_id: r.employee_id,
    discord_server_id: r.discord_server_id,
    roles: r.roles ?? [],
    position: Number(r.position),
  }));
}

export async function findDiscordPlacementById(
  id: string,
): Promise<DiscordPlacementRow | null> {
  const rows = await adminDb.$queryRaw<DiscordPlacementRow[]>`
    SELECT id::text                  AS id,
           employee_id::text         AS employee_id,
           discord_server_id::text   AS discord_server_id,
           roles,
           position
      FROM "employee_discord_server_placements"
     WHERE id = ${id}::uuid
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    employee_id: row.employee_id,
    discord_server_id: row.discord_server_id,
    roles: row.roles ?? [],
    position: Number(row.position),
  };
}

export async function findDiscordPlacementByEmployeeAndServer(
  employeeId: string,
  discordServerId: string,
): Promise<{ id: string } | null> {
  const rows = await adminDb.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM "employee_discord_server_placements"
     WHERE employee_id = ${employeeId}::uuid
       AND discord_server_id = ${discordServerId}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLastPositionInDiscordServer(
  discordServerId: string,
): Promise<number> {
  const rows = await adminDb.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(position)::int AS max
      FROM "employee_discord_server_placements"
     WHERE discord_server_id = ${discordServerId}::uuid
  `;
  const max = rows[0]?.max;
  return max === null || max === undefined ? -1 : Number(max);
}

export async function insertDiscordPlacement(params: {
  employeeId: string;
  discordServerId: string;
  position: number;
  roles?: string[];
}): Promise<{ id: string }> {
  const roles = params.roles ?? [];
  const rows = await adminDb.$queryRaw<{ id: string }[]>`
    INSERT INTO "employee_discord_server_placements"
        ("employee_id", "discord_server_id", "position", "roles")
    VALUES (${params.employeeId}::uuid,
            ${params.discordServerId}::uuid,
            ${params.position},
            ${roles}::text[])
    RETURNING id::text AS id
  `;
  if (!rows[0]) throw new Error("Insert failed");
  return rows[0];
}

export async function updateDiscordPlacementServerAndPosition(
  id: string,
  discordServerId: string,
  position: number,
): Promise<boolean> {
  const result = await adminDb.$executeRaw`
    UPDATE "employee_discord_server_placements"
       SET discord_server_id = ${discordServerId}::uuid,
           position = ${position},
           updated_at = now()
     WHERE id = ${id}::uuid
  `;
  return Number(result) > 0;
}

export async function deleteDiscordPlacement(id: string): Promise<boolean> {
  const result = await adminDb.$executeRaw`
    DELETE FROM "employee_discord_server_placements"
     WHERE id = ${id}::uuid
  `;
  return Number(result) > 0;
}

export async function listDiscordPlacementsByIds(
  ids: string[],
): Promise<{ id: string; discord_server_id: string }[]> {
  if (ids.length === 0) return [];
  const rows = await adminDb.$queryRaw<
    { id: string; discord_server_id: string }[]
  >`
    SELECT id::text                AS id,
           discord_server_id::text AS discord_server_id
      FROM "employee_discord_server_placements"
     WHERE id = ANY(${ids}::uuid[])
  `;
  return rows;
}

export async function updateDiscordPlacementRoles(
  id: string,
  roles: string[],
): Promise<boolean> {
  const result = await adminDb.$executeRaw`
    UPDATE "employee_discord_server_placements"
       SET roles = ${roles}::text[],
           updated_at = now()
     WHERE id = ${id}::uuid
  `;
  return Number(result) > 0;
}
