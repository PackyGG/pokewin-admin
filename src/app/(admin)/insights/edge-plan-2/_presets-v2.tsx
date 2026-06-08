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

import { sanitizeLeversV2, type PlannedLeversV2 } from "./_model-v2";

const STORAGE_KEY = "edge-plan-2:presets:v1";
const STORAGE_VERSION = 1 as const;
const MAX_NAME_LEN = 60;

export type SavedConfigV2 = {
  id: string;
  name: string;
  levers: PlannedLeversV2;
  createdAt: number;
  updatedAt: number;
};

type PresetStore = {
  version: number;
  activeId: string | null;
  configs: SavedConfigV2[];
};

const EMPTY_STORE: PresetStore = {
  version: STORAGE_VERSION,
  activeId: null,
  configs: [],
};

function newId(): string {
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
  const configs: SavedConfigV2[] = [];
  for (const c of rawConfigs) {
    if (c == null || typeof c !== "object") continue;
    const cr = c as Record<string, unknown>;
    if (typeof cr.id !== "string" || cr.id.length === 0) continue;
    if (typeof cr.name !== "string") continue;
    if (cr.levers == null || typeof cr.levers !== "object") continue;
    configs.push({
      id: cr.id,
      name: normalizeName(cr.name),
      levers: sanitizeLeversV2(cr.levers),
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
    /* quota / disabled */
  }
}

function toFiniteTimestamp(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function normalizeName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LEN);
}

function byUpdatedDesc(a: SavedConfigV2, b: SavedConfigV2): number {
  return b.updatedAt - a.updatedAt;
}

function truncateLabel(name: string, max = 22): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

export function leversEqualV2(a: PlannedLeversV2, b: PlannedLeversV2): boolean {
  return JSON.stringify(sanitizeLeversV2(a)) === JSON.stringify(sanitizeLeversV2(b));
}

export type PlannerPresetsV2Api = {
  configs: SavedConfigV2[];
  activeId: string | null;
  activeConfig: SavedConfigV2 | null;
  ready: boolean;
  save: (name: string, levers: PlannedLeversV2) => SavedConfigV2;
  update: (id: string, levers: PlannedLeversV2) => void;
  rename: (id: string, name: string) => void;
  duplicate: (id: string) => SavedConfigV2 | null;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
};

export function usePlannerPresetsV2(): PlannerPresetsV2Api {
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
    (name: string, levers: PlannedLeversV2): SavedConfigV2 => {
      const now = Date.now();
      const cfg: SavedConfigV2 = {
        id: newId(),
        name: normalizeName(name),
        levers: sanitizeLeversV2(levers),
        createdAt: now,
        updatedAt: now,
      };
      persist({
        version: STORAGE_VERSION,
        activeId: cfg.id,
        configs: [cfg, ...store.configs],
      });
      return cfg;
    },
    [persist, store.configs],
  );

  const update = React.useCallback(
    (id: string, levers: PlannedLeversV2) => {
      persist({
        ...store,
        configs: store.configs.map((c) =>
          c.id === id
            ? { ...c, levers: sanitizeLeversV2(levers), updatedAt: Date.now() }
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
    (id: string): SavedConfigV2 | null => {
      const src = store.configs.find((c) => c.id === id);
      if (!src) return null;
      const now = Date.now();
      const copy: SavedConfigV2 = {
        id: newId(),
        name: normalizeName(`${src.name} copy`),
        levers: sanitizeLeversV2(src.levers),
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
    [persist, store.configs],
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

export function PlannerPresetsV2({
  presets,
  currentLevers,
  dirtyVsActive,
  onLoad,
}: {
  presets: PlannerPresetsV2Api;
  currentLevers: PlannedLeversV2;
  dirtyVsActive: boolean;
  onLoad: (config: SavedConfigV2) => void;
}) {
  const { configs, activeConfig, ready, save, update, rename, duplicate, remove } =
    presets;

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<SavedConfigV2 | null>(null);

  const handleLoad = React.useCallback(
    (cfg: SavedConfigV2) => {
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

  const hasConfigs = configs.length > 0;

  return (
    <div className="flex items-center gap-2">
      {ready && activeConfig && (
        <Badge
          variant="outline"
          className={cn(
            "hidden max-w-[14rem] gap-1 truncate sm:inline-flex",
            dirtyVsActive
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          )}
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
              keep a scenario you can reload and compare.
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
                        onClick={() => {
                          const copy = duplicate(cfg.id);
                          if (copy) toast.success(`Duplicated as “${copy.name}”`);
                        }}
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
                        onClick={() => {
                          remove(cfg.id);
                          toast.success(`Deleted “${cfg.name}”`);
                        }}
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

      <NameDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Save config"
        description="Name this lever set so you can reload and compare it later. Stored in this browser only."
        confirmLabel="Save"
        defaultValue=""
        existingNames={configs.map((c) => c.name)}
        onConfirm={handleSave}
      />

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
          <Label htmlFor="edge-plan-v2-preset-name">Config name</Label>
          <Input
            id="edge-plan-v2-preset-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            autoFocus
          />
          {duplicate && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A config with this name already exists — saving anyway is fine.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!valid} onClick={submit}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
