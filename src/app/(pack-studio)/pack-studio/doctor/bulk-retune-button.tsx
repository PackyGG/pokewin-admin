"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { hrefForCurrentHost } from "@/lib/use-app-host";

/**
 * Bulk "Re-tune selected" handoff (owner-only). The doctor grid no longer
 * writes anything itself — the old TOTP dialog, global lever form, and
 * per-pack write loop died with Retune V2. This is a THIN handoff into the
 * Retune workspace's bulk flow (`/pack-studio/retune`), which plans every
 * pack per-pack tag-aware via `planPackTune` and pushes each pack's OWN
 * frozen artifact (approvedPriceAfter + approvedPoolFingerprint pins).
 *
 * Deep-link contract (mirrors the workspace's intake):
 *   • ≤ 20 ids → `?bulk=<id,id,…>` (copy-pasteable URL)
 *   • more     → sessionStorage["pack-studio.retune.bulk-handoff"] = JSON ids
 *                + `?bulk=session` (183 uuids ≈ 6.7 KB — over URL limits)
 */

/** Must match the workspace's `BULK_HANDOFF_KEY` (retune/_workspace/workspace.tsx). */
const BULK_HANDOFF_KEY = "pack-studio.retune.bulk-handoff";

/** Max ids carried in the URL before falling back to the session handoff. */
const MAX_URL_IDS = 20;

export function BulkRetuneButton({
  selected,
}: {
  /** The selected pack ids (+ display names) from the doctor grid. */
  selected: { packId: string; name: string }[];
}) {
  const router = useRouter();
  const count = selected.length;

  function handoff() {
    const ids = selected.map((s) => s.packId);
    if (ids.length === 0) return;
    if (ids.length <= MAX_URL_IDS) {
      router.push(
        hrefForCurrentHost(`/pack-studio/retune?bulk=${ids.join(",")}`),
      );
      return;
    }
    try {
      window.sessionStorage.setItem(BULK_HANDOFF_KEY, JSON.stringify(ids));
      router.push(hrefForCurrentHost("/pack-studio/retune?bulk=session"));
    } catch {
      // sessionStorage unavailable (quota/private mode) — fall back to the
      // URL form; a long URL beats silently dropping the selection.
      router.push(
        hrefForCurrentHost(`/pack-studio/retune?bulk=${ids.join(",")}`),
      );
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={handoff} disabled={count === 0}>
      <SlidersHorizontal className="mr-1 size-3.5" />
      Re-tune selected{count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
