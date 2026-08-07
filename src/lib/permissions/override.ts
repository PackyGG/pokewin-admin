/**
 * Phase C — PURE per-user override helpers for the role/permission rebuild.
 *
 * These functions reconstruct and apply the per-user override layer
 * (grants/revokes) on top of a role baseline, all the way to a materialized
 * `allowed_pages` array via the canonical `computeEffectivePermissions`. They
 * are PURE (no DB, no `server-only`, no Next graph) so the write logic is
 * unit-testable with a plain `node:test`/`tsx --test` runner — see
 * scripts/__fixtures__/override-materializer.test.ts.
 *
 * The server-only glue that READS a user's persisted state from the ADMIN DB
 * lives in src/lib/permissions/write-paths.ts and delegates here.
 *
 * Behavior-preservation contract (the owner's hard rule):
 *   - `deriveOverrideFromAllowedPages` produces the SAME grants/revokes the
 *     read-only parity harness derives, so re-materializing a never-edited
 *     user against their own baseline reproduces their exact `allowed_pages`.
 *   - No function here writes anything; callers decide when to persist.
 */

import { getEffectiveRoles } from "@/lib/admin-roles";
import { baselineTokensFor, type BaselineMap } from "@/lib/role-baselines";
import { computeEffectivePermissions } from "@/lib/permissions/materialize";
import type {
  PermissionToken,
  PermissionOverride,
} from "@/lib/permissions/types";

/**
 * The full baseline token set for an effective role list: the union of every
 * built-in role's code baseline PLUS any custom-role capabilities. This is the
 * "Layer 1 ∪ Layer 2" set the materializer unions before applying the per-user
 * override. Admins are NOT special-cased here (their baseline is `[]`); the
 * gate-bypass short-circuit comes from `computeEffectivePermissions` itself.
 */
function baselineUnionFor(
  roles: readonly string[],
  customRoleTokens: readonly PermissionToken[],
  baselines?: BaselineMap,
): PermissionToken[] {
  const set = new Set<PermissionToken>();
  for (const r of roles) for (const t of baselineTokensFor(r, baselines)) set.add(t);
  for (const t of customRoleTokens) set.add(t);
  return [...set];
}

/**
 * Reconstruct the per-user override `{grants, revokes}` that, unioned onto the
 * given baseline, reproduces `allowedPages` exactly:
 *
 *   grants  = allowedPages \ baseline   (tokens the user has beyond baseline)
 *   revokes = baseline \ allowedPages   (baseline tokens the user lacks)
 *
 * Identical to the derivation the read-only parity harness uses
 * (scripts/permission-parity-harness.mjs) and the source-of-truth for keeping a
 * role-change behavior-preserving: a user whose override columns are still
 * empty has their manual adjustments encoded here, so re-materializing against
 * a NEW baseline keeps those adjustments instead of discarding them.
 *
 * Value tokens (e.g. `__balance_limit_daily:10`) are never in a baseline, so
 * they always fall into `grants` and round-trip verbatim.
 */
function deriveOverrideFromAllowedPages(
  allowedPages: readonly string[],
  baseline: readonly PermissionToken[],
): PermissionOverride {
  const baseSet = new Set(baseline);
  const allowedSet = new Set(allowedPages);
  return {
    grants: allowedPages.filter((k) => !baseSet.has(k)),
    revokes: baseline.filter((k) => !allowedSet.has(k)),
  };
}

/**
 * The minimal persisted permission state the pure write logic needs. Mirrors
 * the server-only `UserPermissionState` (write-paths.ts) without the row `id`.
 */
export type PermissionStateCore = {
  role: string;
  roles: readonly string[];
  customRoleTokens: readonly PermissionToken[];
  allowedPages: readonly string[];
  override: PermissionOverride;
};

/**
 * The effective per-user override for a user whose override columns may still
 * be empty: if the user already has explicit grants/revokes, use them
 * verbatim; otherwise DERIVE them from the gap between their stored
 * `allowed_pages` and their baseline (so a behavior-preserving merge keeps the
 * manual adjustments they made under the old model).
 */
export function effectiveOverrideFor(
  state: PermissionStateCore,
  baselines?: BaselineMap,
): PermissionOverride {
  const hasExplicit =
    state.override.grants.length > 0 || state.override.revokes.length > 0;
  if (hasExplicit) return state.override;
  // Derive against the SAME baseline the re-materialization will use, so a
  // never-edited user's manual adjustments are reconstructed correctly even
  // when the built-in baseline comes from the DB map.
  const baseline = baselineUnionFor(
    state.roles,
    state.customRoleTokens,
    baselines,
  );
  return deriveOverrideFromAllowedPages(state.allowedPages, baseline);
}

/**
 * Re-materialize `allowed_pages` for a user after a ROLE / custom-role change,
 * preserving their per-user override. `newRoles` is the new effective role list
 * (built-ins); `customRoleTokens` is the custom-role capability set after the
 * change. The override is taken from {@link effectiveOverrideFor} so manual
 * adjustments survive. For an `admin`-among-roles user the materializer returns
 * `[]` (gate bypass) — identical to the old paths' admin short-circuit.
 */
export function rematerializeForRoleChange(
  state: PermissionStateCore,
  newRoles: readonly string[],
  customRoleTokens: readonly PermissionToken[],
  baselines?: BaselineMap,
): { allowedPages: string[]; override: PermissionOverride } {
  const override = effectiveOverrideFor(state, baselines);
  const effNewRoles = getEffectiveRoles(newRoles[0] ?? state.role, newRoles);
  const allowedPages = computeEffectivePermissions({
    role: effNewRoles[0] ?? state.role,
    roles: effNewRoles,
    customRoleTokens,
    override,
    baselines,
  });
  return { allowedPages, override };
}

/**
 * Materialize `allowed_pages` for an EXPLICIT override (the per-user editor
 * save). The caller supplies the grants/revokes the operator chose; this unions
 * them onto the user's role + custom-role baseline through the canonical
 * materializer. Pure pass-through — the editor sends the authoritative override.
 */
export function materializeForOverride(
  state: PermissionStateCore,
  override: PermissionOverride,
  baselines?: BaselineMap,
): string[] {
  return computeEffectivePermissions({
    role: state.role,
    roles: state.roles,
    customRoleTokens: state.customRoleTokens,
    override,
    baselines,
  });
}
