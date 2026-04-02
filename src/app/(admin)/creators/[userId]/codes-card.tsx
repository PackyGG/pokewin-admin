"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { addAffiliateCode, removeAffiliateCode, toggleAffiliateCode, toggleCodeActive } from "../actions";

type AdditionalCode = {
  id: string;
  code: string;
  isActive: boolean;
  createdAt: string;
};

export function CodesCard({
  userId,
  primaryCode,
  codeActive,
  additionalCodes,
}: {
  userId: string;
  primaryCode: string;
  codeActive: boolean;
  additionalCodes: AdditionalCode[];
}) {
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdd() {
    if (!newCode.trim()) return;
    startTransition(async () => {
      try {
        await addAffiliateCode(userId, newCode);
        toast.success("Code added");
        setNewCode("");
        setAdding(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add code");
      }
    });
  }

  function handleRemove(codeId: string) {
    startTransition(async () => {
      try {
        await removeAffiliateCode(codeId);
        toast.success("Code removed");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove code");
      }
    });
  }

  function handleToggle(codeId: string, isActive: boolean) {
    startTransition(async () => {
      try {
        await toggleAffiliateCode(codeId, isActive);
        toast.success(isActive ? "Code activated" : "Code deactivated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to toggle code");
      }
    });
  }

  function handleTogglePrimary(active: boolean) {
    startTransition(async () => {
      try {
        await toggleCodeActive(userId, active);
        toast.success(active ? "Primary code activated" : "Primary code deactivated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to toggle code");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Affiliate Codes</CardTitle>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 size-3.5" />
            Add Code
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Primary code */}
        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{primaryCode}</span>
            <Badge variant="outline" className="text-xs">Primary</Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{codeActive ? "Active" : "Inactive"}</span>
            <Switch checked={codeActive} onCheckedChange={handleTogglePrimary} disabled={isPending} />
          </div>
        </div>

        {/* Additional codes */}
        {additionalCodes.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-md border p-3">
            <span className="font-mono text-sm">{c.code}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{c.isActive ? "Active" : "Inactive"}</span>
              <Switch
                checked={c.isActive}
                onCheckedChange={(active) => handleToggle(c.id, active)}
                disabled={isPending}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                onClick={() => handleRemove(c.id)}
                disabled={isPending}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}

        {/* Add new code */}
        {adding && (
          <div className="flex items-center gap-2">
            <Input
              placeholder="Enter code..."
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="h-8 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") { setAdding(false); setNewCode(""); }
              }}
            />
            <Button size="sm" onClick={handleAdd} disabled={isPending}>
              {isPending ? "Adding..." : "Add"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setNewCode(""); }} disabled={isPending}>
              Cancel
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
