"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AFFILIATE_LEVEL_COLORS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils/format";
import { updateLevelConfig } from "../actions";

type LevelConfig = {
  level: number;
  label: string;
  commission_rate: number;
  threshold: number;
};

export function LevelConfigCard({ configs }: { configs: LevelConfig[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Level Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-0 divide-y">
        {configs.map((config) => (
          <LevelRow key={config.level} config={config} />
        ))}
      </CardContent>
    </Card>
  );
}

function LevelRow({ config }: { config: LevelConfig }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(config.label);
  const [rate, setRate] = useState(String(config.commission_rate * 100));
  const [threshold, setThreshold] = useState(String(config.threshold));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const rateVal = parseFloat(rate);
    const thresholdVal = parseFloat(threshold);
    if (isNaN(rateVal) || rateVal < 0 || rateVal > 100) {
      toast.error("Commission rate must be between 0 and 100");
      return;
    }
    if (isNaN(thresholdVal) || thresholdVal < 0) {
      toast.error("Threshold must be a positive number");
      return;
    }
    startTransition(async () => {
      try {
        await updateLevelConfig(config.level, {
          label: label.trim(),
          commissionRate: rateVal / 100,
          threshold: thresholdVal,
        });
        toast.success("Level config updated");
        setEditing(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleCancel() {
    setLabel(config.label);
    setRate(String(config.commission_rate * 100));
    setThreshold(String(config.threshold));
    setEditing(false);
  }

  const commissionPct = (config.commission_rate * 100).toFixed(1);
  const thresholdUsd = config.threshold;

  if (editing) {
    return (
      <div className="flex items-center justify-between py-3">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={AFFILIATE_LEVEL_COLORS[config.level] ?? ""}>
            Level {config.level}
          </Badge>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") handleCancel(); }}
            className="w-[100px] h-7 text-sm"
            placeholder="Label"
          />
          <Input
            type="number"
            step="0.1"
            min="0"
            max="100"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") handleCancel(); }}
            className="w-[70px] h-7 text-sm"
          />
          <span className="text-xs text-muted-foreground">%</span>
          <span className="text-xs text-muted-foreground ml-2">at</span>
          <span className="text-xs text-muted-foreground">$</span>
          <Input
            type="number"
            step="1"
            min="0"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") handleCancel(); }}
            className="w-[100px] h-7 text-sm"
          />
        </div>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" className="size-7" onClick={handleSave} disabled={isPending}>
            <Check className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" onClick={handleCancel} disabled={isPending}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3">
        <Badge variant="outline" className={AFFILIATE_LEVEL_COLORS[config.level] ?? ""}>
          Level {config.level}
        </Badge>
        <span className="text-sm">{config.label}</span>
        <span className="text-sm text-muted-foreground">{commissionPct}%</span>
        <span className="text-xs text-muted-foreground">at {formatCurrency(thresholdUsd)}</span>
      </div>
      <Button variant="ghost" size="icon" className="size-7" onClick={() => setEditing(true)}>
        <Pencil className="size-3.5" />
      </Button>
    </div>
  );
}
