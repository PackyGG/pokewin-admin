"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  Filter,
  Network,
  RefreshCw,
  ShieldAlert,
  ZoomIn,
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

type PositionedNode = Node & { x: number; y: number };

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
  const [zoom, setZoom] = React.useState(1);
  const [selected, setSelected] = React.useState<Node | null>(null);
  const [reason, setReason] = React.useState("Connected account network requires review.");
  const [pending, startTransition] = React.useTransition();
  const zoomClass =
    {
      "0.7": "w-[70%]",
      "0.8": "w-[80%]",
      "0.9": "w-[90%]",
      "1": "w-full",
      "1.1": "w-[110%]",
      "1.2": "w-[120%]",
      "1.3": "w-[130%]",
      "1.4": "w-[140%]",
      "1.5": "w-[150%]",
      "1.6": "w-[160%]",
      "1.7": "w-[170%]",
      "1.8": "w-[180%]",
    }[String(zoom)] ?? "w-full";

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
        (edge) =>
          visibleKeys.has(edge.source) && visibleKeys.has(edge.target),
      ),
    [edges, visibleKeys],
  );
  const positioned = React.useMemo(() => {
    const accounts = visibleNodes.filter((node) => node.type === "account");
    const connectors = visibleNodes.filter((node) => node.type !== "account");
    const result = new Map<string, PositionedNode>();
    const place = (items: Node[], radius: number, phase: number) => {
      items.forEach((node, index) => {
        const angle = phase + (Math.PI * 2 * index) / Math.max(1, items.length);
        result.set(node.key, {
          ...node,
          x: 500 + Math.cos(angle) * radius,
          y: 310 + Math.sin(angle) * radius,
        });
      });
    };
    place(connectors, Math.min(180, 80 + connectors.length * 3), 0);
    place(accounts, Math.min(280, 170 + accounts.length * 2), Math.PI / 2);
    return result;
  }, [visibleNodes]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-card p-2.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="size-3.5" />
          Connections
        </span>
        <Button
          type="button"
          size="sm"
          variant={showIps ? "default" : "outline"}
          onClick={() => setShowIps((value) => !value)}
        >
          IP
        </Button>
        <Button
          type="button"
          size="sm"
          variant={showDevices ? "default" : "outline"}
          onClick={() => setShowDevices((value) => !value)}
        >
          Device
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <ZoomIn className="size-3.5" />
          <input
            type="range"
            min="0.7"
            max="1.8"
            step="0.1"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label="Map zoom"
          />
        </label>
      </div>

      <div className="overflow-auto rounded-xl border border-border/70 bg-card shadow-sm">
        <svg
          viewBox="0 0 1000 620"
          role="img"
          aria-label="Connected account network map"
          className={cn("min-h-[520px] text-border", zoomClass)}
        >
          {visibleEdges.map((edge) => {
            const source = positioned.get(edge.source);
            const target = positioned.get(edge.target);
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.source}-${edge.target}-${edge.type}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke="currentColor"
                strokeWidth={edge.type === "shared_device" ? 2 : 1.25}
                className={
                  edge.type === "shared_device"
                    ? "text-purple-500/35"
                    : "text-cyan-500/30"
                }
              />
            );
          })}
          {[...positioned.values()].map((node) => {
            const root = node.user_id === rootUserId;
            const radius =
              node.type === "account"
                ? root
                  ? 24
                  : 18
                : Math.min(34, 15 + node.degree * 1.5);
            return (
              <g
                key={node.key}
                role="button"
                tabIndex={0}
                aria-label={`${node.type}: ${node.label}`}
                onClick={() => setSelected(node)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    setSelected(node);
                  }
                }}
                className="cursor-pointer outline-none"
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  className={cn(
                    "stroke-background stroke-[3]",
                    node.type === "account" &&
                      (root ? "fill-rose-500" : "fill-cyan-500"),
                    node.type === "ip" && "fill-amber-500",
                    node.type === "device" && "fill-purple-500",
                  )}
                />
                <text
                  x={node.x}
                  y={node.y + radius + 14}
                  textAnchor="middle"
                  className="fill-foreground text-[11px] font-medium"
                >
                  {node.label.length > 22
                    ? `${node.label.slice(0, 20)}…`
                    : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.45fr)]">
        <div className="rounded-lg border border-border/70 bg-card p-3">
          <p className="text-xs font-semibold">Selected node</p>
          {selected ? (
            <div className="mt-2 space-y-2 text-xs">
              <p className="font-medium">{selected.label}</p>
              <p className="text-muted-foreground">
                {selected.type} · {selected.degree} connection
                {selected.degree === 1 ? "" : "s"}
              </p>
              {selected.user_id && (
                <Button
                  size="sm"
                  variant="outline"
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
                        toast.success(`Exact IP: ${exact}`, { duration: 10_000 });
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
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              Select an account, masked IP, or device bubble.
            </p>
          )}
        </div>

        <div className="space-y-2 rounded-lg border border-border/70 bg-card p-3">
          <p className="text-xs font-semibold">Review actions</p>
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
