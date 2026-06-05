"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { sanitizeLevers, type PlannedLevers } from "./_model";

/**
 * _presets.tsx — CLIENT-SIDE (localStorage) saved configs for the System Edge
 * Plan planner.
 *
 * Lets the owner save the full lever set as a NAMED config and keep several
 * around to try ideas against ("add multiple configs to try around"). Pure
 * client state — NO server / DB writes (the planner is read-only; the levers
 * are a plain serializable object that round-trips through `JSON`).
 *
 * Storage shape (one namespaced key):
 *   {
 *     version: 1,
 *     activeId: string | null,         // the config currently loaded (if any)
 *     configs: SavedConfig[]           // newest-updated first when listed
 *   }
 *
 * Every read is defensively validated and every lever object is run through the
 * model's `sanitizeLevers` so a hand-edited / stale / partial payload can never
 * feed NaN or a missing key into the projection. A corrupt blob degrades to
 * "no saved configs" rather than throwing.
 */

const STORAGE_KEY = "system-edge-plan:presets:v1";
const STORAGE_VERSION = 1 as const;
const MAX_NAME_LEN = 60;

export type SavedConfig = {
  id: string;
  name: string;
  /** The full lever set (sanitized on read). */
  levers: PlannedLevers;
  createdAt: number;
  updatedAt: number;
};

type PresetStore = {
  version: number;
  activeId: string | null;
  configs: SavedConfig[];
};

const EMPTY_STORE: PresetStore = {
  version: STORAGE_VERSION,
  activeId: null,
  configs: [],
};

// ─── Storage (defensive read / write) ───────────────────────────────────────

function newId(): string {
  // crypto.randomUUID is available in every browser this admin targets; the
  // fallback keeps the module safe in non-secure-context / SSR-ish edge cases.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readStore(): PresetStore {
  if (typeof window === "undefined") return EMPTY_STORE;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage disabled (private mode etc.) — behave as if empty.
    return EMPTY_STORE;
  }
  if (!raw) return EMPTY_STORE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STORE;
  }
  if (parsed == null || typeof parsed !== "object") return EMPTY_STORE;

  const rec = parsed as Record<string, unknown>;
  const rawConfigs = Array.isArray(rec.configs) ? rec.configs : [];
  const configs: SavedConfig[] = [];
  for (const c of rawConfigs) {
    if (c == null || typeof c !== "object") continue;
    const cr = c as Record<string, unknown>;
    if (typeof cr.id !== "string" || cr.id.length === 0) continue;
    if (typeof cr.name !== "string") continue;
    if (cr.levers == null || typeof cr.levers !== "object") continue;
    configs.push({
      id: cr.id,
      name: normalizeName(cr.name),
      // The single trust boundary: every stored lever set is re-sanitized so a
      // partial / corrupted payload can never feed the projection.
      levers: sanitizeLevers(cr.levers),
      createdAt: toFiniteTimestamp(cr.createdAt),
      updatedAt: toFiniteTimestamp(cr.updatedAt),
    });
  }

  const activeId =
    typeof rec.activeId === "string" && configs.some((c) => c.id === rec.activeId)
      ? rec.activeId
      : null;

  return { version: STORAGE_VERSION, activeId, configs };
}

function writeStore(store: PresetStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota / disabled storage: keep working for the session, just don't persist.
  }
}

function toFiniteTimestamp(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function normalizeName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LEN);
}

/** Newest-updated first — the natural order for a "recent configs" list. */
function byUpdatedDesc(a: SavedConfig, b: SavedConfig): number {
  return b.updatedAt - a.updatedAt;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export type PlannerPresetsApi = {
  /** Saved configs, newest-updated first. */
  configs: SavedConfig[];
  /** The active config (the one currently loaded), or null. */
  activeId: string | null;
  activeConfig: SavedConfig | null;
  /** True once the store has been read from localStorage (post-mount). */
  ready: boolean;
  /** Save the given lever set as a NEW named config and make it active. */
  save: (name: string, levers: PlannedLevers) => SavedConfig;
  /** Overwrite the active config's levers with the given set (update in place). */
  update: (id: string, levers: PlannedLevers) => void;
  rename: (id: string, name: string) => void;
  duplicate: (id: string) => SavedConfig | null;
  remove: (id: string) => void;
  /** Mark a config active (or none). Does NOT mutate the levers itself. */
  setActive: (id: string | null) => void;
};

/**
 * Manage the localStorage-backed preset store. First render returns an empty,
 * not-ready store so SSR and the initial client render agree (no hydration
 * mismatch); the persisted store is hydrated in a mount effect.
 */
export function usePlannerPresets(): PlannerPresetsApi {
  const [store, setStore] = React.useState<PresetStore>(EMPTY_STORE);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setStore(readStore());
    setReady(true);
  }, []);

  const persist = React.useCallback((next: PresetStore) => {
    setStore(next);
    writeStore(next);
  }, []);

  const save = React.useCallback(
    (name: string, levers: PlannedLevers): SavedConfig => {
      const now = Date.now();
      const cfg: SavedConfig = {
        id: newId(),
        name: normalizeName(name),
        levers: sanitizeLevers(levers),
        createdAt: now,
        updatedAt: now,
      };
      persist((() => {
        const cur = store;
        return {
          version: STORAGE_VERSION,
          activeId: cfg.id,
          configs: [cfg, ...cur.configs],
        };
      })());
      return cfg;
    },
    [persist, store],
  );

  const update = React.useCallback(
    (id: string, levers: PlannedLevers) => {
      persist({
        ...store,
        configs: store.configs.map((c) =>
          c.id === id
            ? { ...c, levers: sanitizeLevers(levers), updatedAt: Date.now() }
            : c,
        ),
      });
    },
    [persist, store],
  );

  const rename = React.useCallback(
    (id: string, name: string) => {
      const clean = normalizeName(name);
      if (clean.length === 0) return;
      persist({
        ...store,
        configs: store.configs.map((c) =>
          c.id === id ? { ...c, name: clean, updatedAt: Date.now() } : c,
        ),
      });
    },
    [persist, store],
  );

  const duplicate = React.useCallback(
    (id: string): SavedConfig | null => {
      const src = store.configs.find((c) => c.id === id);
      if (!src) return null;
      const now = Date.now();
      const copy: SavedConfig = {
        id: newId(),
        name: normalizeName(`${src.name} copy`),
        levers: sanitizeLevers(src.levers),
        createdAt: now,
        updatedAt: now,
      };
      persist({
        version: STORAGE_VERSION,
        activeId: copy.id,
        configs: [copy, ...store.configs],
      });
      return copy;
    },
    [persist, store],
  );

  const remove = React.useCallback(
    (id: string) => {
      persist({
        ...store,
        activeId: store.activeId === id ? null : store.activeId,
        configs: store.configs.filter((c) => c.id !== id),
      });
    },
    [persist, store],
  );

  const setActive = React.useCallback(
    (id: string | null) => {
      if (id != null && !store.configs.some((c) => c.id === id)) return;
      persist({ ...store, activeId: id });
    },
    [persist, store],
  );

  const configs = React.useMemo(
    () => [...store.configs].sort(byUpdatedDesc),
    [store.configs],
  );
  const activeConfig = React.useMemo(
    () => store.configs.find((c) => c.id === store.activeId) ?? null,
    [store.configs, store.activeId],
  );

  return {
    configs,
    activeId: store.activeId,
    activeConfig,
    ready,
    save,
    update,
    rename,
    duplicate,
    remove,
    setActive,
  };
}

// ─── UI ────────────────────────────────────────────────────────────────────

/**
 * The "Configs" control near the planner header. A dropdown listing the saved
 * configs (load / duplicate / rename / delete each) plus Save / Update actions,
 * and a small active / unsaved-changes indicator.
 *
 * House-POV / tone-neutral: this is a management control, no money colours.
 * All callbacks are client→client function props (the RSC-boundary rule only
 * forbids server→client function props — this whole subtree is `"use client"`).
 */
export function PlannerPresets({
  presets,
  currentLevers,
  dirtyVsActive,
  onLoad,
}: {
  presets: PlannerPresetsApi;
  /** The planner's current lever state (what "Save" / "Update" captures). */
  currentLevers: PlannedLevers;
  /**
   * True when `currentLevers` differs from the active config (or from the live
   * baseline when no config is active) — drives the unsaved-changes badge.
   */
  dirtyVsActive: boolean;
  /** Apply a saved config's levers into the planner. */
  onLoad: (config: SavedConfig) => void;
}) {
  const { configs, activeConfig, ready, save, update, rename, duplicate, remove } =
    presets;

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<SavedConfig | null>(null);

  const handleLoad = React.useCallback(
    (cfg: SavedConfig) => {
      onLoad(cfg);
      presets.setActive(cfg.id);
      toast.success(`Loaded “${cfg.name}”`);
    },
    [onLoad, presets],
  );

  const handleSave = React.useCallback(
    (name: string) => {
      const cfg = save(name, currentLevers);
      toast.success(`Saved config “${cfg.name}”`);
    },
    [save, currentLevers],
  );

  const handleUpdate = React.useCallback(() => {
    if (!activeConfig) return;
    update(activeConfig.id, currentLevers);
    toast.success(`Updated “${activeConfig.name}”`);
  }, [activeConfig, update, currentLevers]);

  const handleDuplicate = React.useCallback(
    (cfg: SavedConfig) => {
      const copy = duplicate(cfg.id);
      if (copy) toast.success(`Duplicated as “${copy.name}”`);
    },
    [duplicate],
  );

  const handleDelete = React.useCallback(
    (cfg: SavedConfig) => {
      remove(cfg.id);
      toast.success(`Deleted “${cfg.name}”`);
    },
    [remove],
  );

  // Pre-mount (or storage-empty) we still render the control so the header
  // layout is stable; the list is just empty until `ready`.
  const hasConfigs = configs.length > 0;

  return (
    <div className="flex items-center gap-2">
      {/* Active / unsaved indicator */}
      {ready && activeConfig && (
        <Badge
          variant="outline"
          className={cn(
            "hidden max-w-[14rem] gap-1 truncate sm:inline-flex",
            dirtyVsActive
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          )}
          title={
            dirtyVsActive
              ? `Unsaved changes vs “${activeConfig.name}”`
              : `Matches “${activeConfig.name}”`
          }
        >
          <span className="truncate">{activeConfig.name}</span>
          <span className="shrink-0 opacity-80">
            {dirtyVsActive ? "· edited" : "· saved"}
          </span>
        </Badge>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="gap-1.5" />}
        >
          <FolderOpen className="size-3.5" />
          Configs
          {ready && hasConfigs && (
            <span className="ml-0.5 rounded bg-muted px-1 text-[10px] font-semibold tabular-nums text-muted-foreground">
              {configs.length}
            </span>
          )}
          <ChevronDown className="size-3.5 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Saved configs</DropdownMenuLabel>

          {!hasConfigs ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No saved configs yet. Tune the levers, then “Save current as…” to
              keep a config you can reload and compare.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {configs.map((cfg) => {
                const isActive = cfg.id === activeConfig?.id;
                return (
                  <div
                    key={cfg.id}
                    className={cn(
                      "group flex items-center gap-1 rounded-md px-1.5 py-1",
                      isActive && "bg-accent/50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleLoad(cfg)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      title={`Load “${cfg.name}”`}
                    >
                      {isActive ? (
                        <Check className="size-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{cfg.name}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6"
                        title="Duplicate"
                        onClick={() => handleDuplicate(cfg)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6"
                        title="Rename"
                        onClick={() => setRenameTarget(cfg)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-muted-foreground hover:text-rose-500"
                        title="Delete"
                        onClick={() => handleDelete(cfg)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <DropdownMenuSeparator />
          {activeConfig && (
            <DropdownMenuItem
              onClick={handleUpdate}
              disabled={!dirtyVsActive}
              title={
                dirtyVsActive
                  ? `Overwrite “${activeConfig.name}” with the current levers`
                  : "No changes to save"
              }
            >
              <Save className="size-3.5" />
              Update “{truncateLabel(activeConfig.name)}”
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setSaveOpen(true)}>
            <Plus className="size-3.5" />
            Save current as…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save-as dialog */}
      <NameDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save config"
        description="Name this lever set so you can reload and compare it later. Stored in this browser only — no live data is changed."
        confirmLabel="Save"
        defaultValue=""
        existingNames={configs.map((c) => c.name)}
        onConfirm={handleSave}
      />

      {/* Rename dialog */}
      <NameDialog
        open={renameTarget != null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
        title="Rename config"
        description="Give this saved config a new name."
        confirmLabel="Rename"
        defaultValue={renameTarget?.name ?? ""}
        existingNames={configs
          .filter((c) => c.id !== renameTarget?.id)
          .map((c) => c.name)}
        onConfirm={(name) => {
          if (renameTarget) rename(renameTarget.id, name);
        }}
      />
    </div>
  );
}

/**
 * A tiny single-input dialog used for both Save-as and Rename. Validates a
 * non-empty name and warns (non-blocking) on a duplicate.
 */
function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  defaultValue,
  existingNames,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  defaultValue: string;
  existingNames: string[];
  onConfirm: (name: string) => void;
}) {
  const [value, setValue] = React.useState(defaultValue);

  // Reset the field whenever the dialog (re)opens with a (possibly new) default.
  React.useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0;
  const duplicate = existingNames.some(
    (n) => n.toLowerCase() === trimmed.toLowerCase(),
  );

  const submit = () => {
    if (!valid) return;
    onConfirm(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="preset-name">Config name</Label>
          <Input
            id="preset-name"
            value={value}
            maxLength={MAX_NAME_LEN}
            autoFocus
            placeholder="e.g. Lower rakeback + higher edge"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {duplicate && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Another config already uses this name — saving will create a
              separate entry.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid} className="gap-1.5">
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function truncateLabel(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}
