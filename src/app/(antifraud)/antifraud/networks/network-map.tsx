"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Crosshair,
  Eye,
  Fingerprint,
  Maximize2,
  Minus,
  Network,
  Plus,
  RefreshCw,
  ShieldAlert,
  User,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  openAccountNetworkCase,
  rescanAccountNetwork,
  revealAccountNetworkIp,
} from "./actions";

type Node = {
  key: string;
  type: "account" | "ip" | "device";
  user_id: string | null;
  label: string;
  metadata: Record<string, unknown>;
  degree: number;
};

type Edge = {
  source: string;
  target: string;
  type: "shared_ip" | "shared_device";
};

type PositionedNode = Node & { x: number; y: number; r: number };

const VIEW_W = 1000;
const VIEW_H = 620;
const PAD = 56;

const NODE_STYLE = {
  account: { fill: "fill-cyan-500", dot: "bg-cyan-500", icon: User },
  ip: { fill: "fill-amber-500", dot: "bg-amber-500", icon: Wifi },
  device: { fill: "fill-purple-500", dot: "bg-purple-500", icon: Fingerprint },
} as const;

/**
 * Deterministic force-directed layout (Fruchterman-Reingold).
 *
 * The previous layout parked every node on one of two fixed rings, which
 * made real networks unreadable: edges crossed the whole canvas, hubs sat
 * next to unrelated leaves, and labels stacked on top of each other. A
 * force pass pulls connected accounts around their shared IP/device hub
 * and pushes unrelated clusters apart, so the picture matches the data.
 *
 * Seeded from a golden-angle spiral (never Math.random) so the same graph
 * always renders identically — no layout jitter between renders.
 */
function computeLayout(nodes: Node[], edges: Edge[]): Map<string, PositionedNode> {
  const result = new Map<string, PositionedNode>();
  const n = nodes.length;
  if (n === 0) return result;

  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);

  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const radius = 260 * Math.sqrt((i + 0.5) / n);
    xs[i] = Math.cos(GOLDEN * i) * radius;
    ys[i] = Math.sin(GOLDEN * i) * radius;
  }

  const links: Array<[number, number]> = [];
  for (const edge of edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }

  // Ideal edge length. Scales down as the graph grows so a 200-node page
  // still fits the canvas after the fit-to-box normalisation below.
  const k = Math.max(26, Math.sqrt((VIEW_W * VIEW_H) / n) * 0.62);
  const iterations = Math.max(90, Math.min(320, Math.round(9000 / n)));
  let temperature = k * 2.2;
  const cooling = Math.pow(0.02, 1 / iterations);

  for (let step = 0; step < iterations; step += 1) {
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ox = xs[i] - xs[j];
        let oy = ys[i] - ys[j];
        let distSq = ox * ox + oy * oy;
        if (distSq < 0.01) {
          // Deterministic nudge for exactly-overlapping seeds.
          ox = (i % 2 === 0 ? 1 : -1) * 0.1;
          oy = 0.1;
          distSq = 0.02;
        }
        const dist = Math.sqrt(distSq);
        const force = (k * k) / dist;
        const fx = (ox / dist) * force;
        const fy = (oy / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    for (const [a, b] of links) {
      const ox = xs[a] - xs[b];
      const oy = ys[a] - ys[b];
      const dist = Math.sqrt(ox * ox + oy * oy) || 0.01;
      const force = (dist * dist) / k;
      const fx = (ox / dist) * force;
      const fy = (oy / dist) * force;
      dx[a] -= fx;
      dy[a] -= fy;
      dx[b] += fx;
      dy[b] += fy;
    }

    for (let i = 0; i < n; i += 1) {
      // Weak gravity keeps disconnected fragments from drifting off-canvas.
      dx[i] -= xs[i] * 0.012;
      dy[i] -= ys[i] * 0.012;

      const disp = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01;
      const limit = Math.min(disp, temperature);
      xs[i] += (dx[i] / disp) * limit;
      ys[i] += (dy[i] / disp) * limit;
    }

    temperature *= cooling;
  }

  // Fit the settled cloud into the viewBox with room for labels.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((VIEW_W - PAD * 2) / spanX, (VIEW_H - PAD * 2) / spanY);
  const offsetX = (VIEW_W - spanX * scale) / 2 - minX * scale;
  const offsetY = (VIEW_H - spanY * scale) / 2 - minY * scale;

  nodes.forEach((node, i) => {
    const r =
      node.type === "account"
        ? 11
        : Math.min(26, 12 + Math.sqrt(Math.max(0, node.degree)) * 3.2);
    result.set(node.key, {
      ...node,
      x: xs[i] * scale + offsetX,
      y: ys[i] * scale + offsetY,
      r,
    });
  });

  return result;
}

function metadataRows(metadata: Record<string, unknown>) {
  return Object.entries(metadata)
    .filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
    .slice(0, 8)
    .map(([key, value]) => [key.replace(/_/g, " "), String(value)] as const);
}

export function AccountNetworkMap({
  snapshotId,
  rootUserId,
  nodes,
  edges,
}: {
  snapshotId: string;
  rootUserId: string;
  nodes: Node[];
  edges: Edge[];
}) {
  const router = useRouter();
  const [showIps, setShowIps] = React.useState(true);
  const [showDevices, setShowDevices] = React.useState(true);
  const [view, setView] = React.useState({ x: 0, y: 0, scale: 1 });
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState(
    "Connected account network requires review.",
  );
  const [pending, startTransition] = React.useTransition();
  const drag = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);

  const visibleNodes = React.useMemo(
    () =>
      nodes.filter(
        (node) =>
          node.type === "account" ||
          (node.type === "ip" && showIps) ||
          (node.type === "device" && showDevices),
      ),
    [nodes, showDevices, showIps],
  );
  const visibleKeys = React.useMemo(
    () => new Set(visibleNodes.map((node) => node.key)),
    [visibleNodes],
  );
  const visibleEdges = React.useMemo(
    () =>
      edges.filter(
        (edge) => visibleKeys.has(edge.source) && visibleKeys.has(edge.target),
      ),
    [edges, visibleKeys],
  );
  const positioned = React.useMemo(
    () => computeLayout(visibleNodes, visibleEdges),
    [visibleNodes, visibleEdges],
  );
  const placedNodes = React.useMemo(
    () => [...positioned.values()],
    [positioned],
  );

  // Adjacency drives the focus highlight: hovering or selecting a node dims
  // everything it is not directly connected to, which is the only way to read
  // a dense component without opening every bubble one by one.
  const neighbours = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of visibleEdges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [visibleEdges]);

  const focusKey = hovered ?? selectedKey;
  const focusSet = React.useMemo(() => {
    if (!focusKey) return null;
    const set = new Set<string>([focusKey]);
    for (const key of neighbours.get(focusKey) ?? []) set.add(key);
    return set;
  }, [focusKey, neighbours]);

  const selected = selectedKey ? (positioned.get(selectedKey) ?? null) : null;

  const zoomBy = React.useCallback((factor: number) => {
    setView((current) => {
      const scale = Math.min(6, Math.max(0.5, current.scale * factor));
      // Zoom around the canvas centre so the focused area stays put.
      const cx = VIEW_W / 2;
      const cy = VIEW_H / 2;
      return {
        scale,
        x: cx - ((cx - current.x) / current.scale) * scale,
        y: cy - ((cy - current.y) / current.scale) * scale,
      };
    });
  }, []);

  const resetView = React.useCallback(
    () => setView({ x: 0, y: 0, scale: 1 }),
    [],
  );

  const focusRoot = React.useCallback(() => {
    const root = placedNodes.find((node) => node.user_id === rootUserId);
    if (!root) return;
    const scale = 2;
    setView({
      scale,
      x: VIEW_W / 2 - root.x * scale,
      y: VIEW_H / 2 - root.y * scale,
    });
    setSelectedKey(root.key);
  }, [placedNodes, rootUserId]);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const svg = svgRef.current;
    if (!svg) return;
    // Convert screen pixels to viewBox units so panning tracks the cursor
    // exactly at any container width.
    const rect = svg.getBoundingClientRect();
    const ratio = VIEW_W / (rect.width || VIEW_W);
    const moveX = (event.clientX - state.startX) * ratio;
    const moveY = (event.clientY - state.startY) * ratio;
    if (Math.abs(moveX) + Math.abs(moveY) > 3) state.moved = true;
    setView((current) => ({
      ...current,
      x: state.originX + moveX,
      y: state.originY + moveY,
    }));
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
  };

  const nodeCount = placedNodes.length;
  // Labelling every bubble in a dense component is noise; past ~70 nodes only
  // accounts (and whatever is focused) keep a permanent label.
  const labelAll = nodeCount <= 70;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <FilterChip
          active={showIps}
          onClick={() => setShowIps((value) => !value)}
          icon={Wifi}
          dot="bg-amber-500"
          label="Shared IPs"
        />
        <FilterChip
          active={showDevices}
          onClick={() => setShowDevices((value) => !value)}
          icon={Fingerprint}
          dot="bg-purple-500"
          label="Shared devices"
        />
        <span className="ml-1 hidden text-[11px] text-muted-foreground sm:inline">
          {nodeCount} nodes · {visibleEdges.length} links
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={focusRoot}
            title="Centre on the searched account"
          >
            <Crosshair className="size-3.5" />
            <span className="hidden sm:inline">Focus root</span>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => zoomBy(1 / 1.3)}
            aria-label="Zoom out"
          >
            <Minus className="size-3.5" />
          </Button>
          <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(view.scale * 100)}%
          </span>
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => zoomBy(1.3)}
            aria-label="Zoom in"
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={resetView}
            aria-label="Reset view"
          >
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border bg-card">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="Connected account network map"
          className={cn(
            "block h-[560px] w-full touch-none select-none",
            drag.current ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <defs>
            <pattern
              id="network-grid"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M40 0H0V40"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                className="text-border/40"
              />
            </pattern>
          </defs>
          <rect width={VIEW_W} height={VIEW_H} fill="url(#network-grid)" />

          <g
            transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
          >
            {visibleEdges.map((edge) => {
              const source = positioned.get(edge.source);
              const target = positioned.get(edge.target);
              if (!source || !target) return null;
              const dimmed =
                focusSet !== null &&
                !(focusSet.has(edge.source) && focusSet.has(edge.target));
              return (
                <line
                  key={`${edge.source}-${edge.target}-${edge.type}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="currentColor"
                  strokeWidth={
                    (edge.type === "shared_device" ? 1.6 : 1.1) /
                    Math.max(1, view.scale * 0.6)
                  }
                  strokeLinecap="round"
                  className={cn(
                    "transition-opacity",
                    edge.type === "shared_device"
                      ? "text-purple-500"
                      : "text-cyan-500",
                    dimmed ? "opacity-[0.06]" : "opacity-40",
                  )}
                />
              );
            })}

            {placedNodes.map((node) => {
              const root = node.user_id === rootUserId;
              const active = selectedKey === node.key || hovered === node.key;
              const dimmed = focusSet !== null && !focusSet.has(node.key);
              const style = NODE_STYLE[node.type];
              const showLabel = labelAll || node.type === "account" || active;
              return (
                <g
                  key={node.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.type}: ${node.label}, ${node.degree} connections`}
                  onClick={() => {
                    if (drag.current?.moved) return;
                    setSelectedKey((current) =>
                      current === node.key ? null : node.key,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedKey(node.key);
                    }
                  }}
                  onPointerEnter={() => setHovered(node.key)}
                  onPointerLeave={() =>
                    setHovered((current) =>
                      current === node.key ? null : current,
                    )
                  }
                  className={cn(
                    "cursor-pointer outline-none transition-opacity",
                    dimmed ? "opacity-20" : "opacity-100",
                  )}
                >
                  {(root || active) && (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.r + 7}
                      fill="none"
                      strokeWidth={2}
                      className={cn(
                        root ? "stroke-rose-500/60" : "stroke-foreground/40",
                      )}
                    />
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    className={cn(
                      "stroke-card stroke-[2.5]",
                      root ? "fill-rose-500" : style.fill,
                    )}
                  />
                  {showLabel && (
                    <text
                      x={node.x}
                      y={node.y + node.r + 13}
                      textAnchor="middle"
                      paintOrder="stroke"
                      stroke="var(--card)"
                      strokeWidth={3.5}
                      strokeLinejoin="round"
                      className="pointer-events-none fill-foreground text-[10px] font-medium"
                    >
                      {node.label.length > 20
                        ? `${node.label.slice(0, 18)}…`
                        : node.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border bg-card/90 px-2.5 py-1.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
          <LegendDot className="bg-rose-500" label="Searched account" />
          <LegendDot className="bg-cyan-500" label="Linked account" />
          <LegendDot className="bg-amber-500" label="IP" />
          <LegendDot className="bg-purple-500" label="Device" />
        </div>
        <p className="pointer-events-none absolute right-3 top-3 rounded-md border bg-card/90 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
          Drag to pan · click a node to inspect
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.45fr)]">
        <div className="rounded-lg border bg-card p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Selected node
          </p>
          {selected ? (
            <div className="mt-2 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded-md p-1.5",
                    selected.user_id === rootUserId
                      ? "bg-rose-500/10 text-rose-500"
                      : selected.type === "account"
                        ? "bg-cyan-500/10 text-cyan-500"
                        : selected.type === "ip"
                          ? "bg-amber-500/10 text-amber-500"
                          : "bg-purple-500/10 text-purple-500",
                  )}
                >
                  {React.createElement(NODE_STYLE[selected.type].icon, {
                    className: "size-4",
                  })}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">
                    {selected.label}
                  </span>
                  <span className="block text-xs capitalize text-muted-foreground">
                    {selected.type} · {selected.degree} connection
                    {selected.degree === 1 ? "" : "s"}
                  </span>
                </span>
              </div>

              {metadataRows(selected.metadata).length > 0 && (
                <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  {metadataRows(selected.metadata).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-2">
                      <dt className="truncate capitalize text-muted-foreground">
                        {key}
                      </dt>
                      <dd className="truncate font-medium tabular-nums">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="flex flex-wrap gap-2">
                {selected.user_id && (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={<HostLink href={`/users/${selected.user_id}`} />}
                  >
                    Open account
                  </Button>
                )}
                {selected.type === "ip" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        try {
                          const exact = await revealAccountNetworkIp({
                            snapshotId,
                            nodeKey: selected.key,
                          });
                          toast.success(`Exact IP: ${exact}`, {
                            duration: 10_000,
                          });
                        } catch (error) {
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : "IP reveal failed",
                          );
                        }
                      })
                    }
                  >
                    <Eye className="size-3.5" />
                    Reveal exact IP
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Select an account, masked IP, or device bubble to see its
              details.
            </p>
          )}
        </div>

        <div className="space-y-2 rounded-lg border bg-card p-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Review actions
          </p>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-label="Network case reason"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    const caseId = await openAccountNetworkCase({
                      snapshotId,
                      reason,
                      idempotencyKey: crypto.randomUUID(),
                    });
                    router.push(`/antifraud/monitor/cases/${caseId}`);
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "Case open failed",
                    );
                  }
                })
              }
            >
              <ShieldAlert className="size-3.5" />
              Open network case
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await rescanAccountNetwork({ userId: rootUserId });
                    toast.success("Fresh network scan queued");
                    router.refresh();
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : "Rescan failed",
                    );
                  }
                })
              }
            >
              <RefreshCw className="size-3.5" />
              Rescan
            </Button>
          </div>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Network className="size-3.5" />
        Account links open the normal user profile. IPs stay masked until a
        separately authorized reveal.
      </p>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  icon: Icon,
  dot,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  dot: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-border bg-accent text-foreground"
          : "border-dashed text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      <span
        className={cn(
          "size-1.5 rounded-full",
          active ? dot : "bg-muted-foreground/40",
        )}
      />
    </button>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", className)} />
      {label}
    </span>
  );
}
