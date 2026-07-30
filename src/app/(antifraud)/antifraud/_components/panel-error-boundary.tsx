"use client";

import * as React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

type State = {
  failed: boolean;
  correlationId: string | null;
};

export class PanelErrorBoundary extends React.Component<
  { children: React.ReactNode; label: string },
  State
> {
  state: State = { failed: false, correlationId: null };

  static getDerivedStateFromError(): State {
    return { failed: true, correlationId: null };
  }

  componentDidCatch(error: unknown): void {
    const correlationId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `panel-${Date.now().toString(36)}`;
    console.error("[antifraud-panel] isolated render failure", {
      correlationId,
      label: this.props.label,
      error,
    });
    this.setState({ correlationId });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-center">
        <AlertTriangle className="size-5 text-amber-500" aria-hidden />
        <p className="text-sm font-semibold">
          {this.props.label} could not be displayed
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          The rest of Fraud remains available. Retry this panel.
          {this.state.correlationId
            ? ` Correlation ${this.state.correlationId}.`
            : ""}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            this.setState({ failed: false, correlationId: null })
          }
        >
          <RotateCw className="size-3.5" aria-hidden />
          Retry panel
        </Button>
      </div>
    );
  }
}
