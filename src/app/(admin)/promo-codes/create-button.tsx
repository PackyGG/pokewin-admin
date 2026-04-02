"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createPromoCode } from "./actions";

export function CreatePromoCodeButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [code, setCode] = useState("");
  const [value, setValue] = useState("");
  const [minimumLevel, setMinimumLevel] = useState("0");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresAt, setExpiresAt] = useState("");

  function handleSubmit() {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue <= 0) {
      toast.error("Please enter a valid value");
      return;
    }
    if (!code.trim()) {
      toast.error("Please enter a code");
      return;
    }

    startTransition(async () => {
      try {
        await createPromoCode({
          code: code.trim(),
          value: numValue,
          region: "NA",
          minimumLevel: parseInt(minimumLevel) || 0,
          maxUses: parseInt(maxUses) || 1,
          expiresAt: expiresAt || null,
        });
        toast.success("Promo code created");
        setOpen(false);
        setCode("");
        setValue("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create promo code");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        Create Promo Code
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Promo Code</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="SUMMER2024" />
          </div>
          <div className="space-y-2">
            <Label>Value (USD)</Label>
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="5.00" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Min Level</Label>
              <Input type="number" value={minimumLevel} onChange={(e) => setMinimumLevel(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Max Uses</Label>
              <Input type="number" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Expires At (optional)</Label>
            <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <Button onClick={handleSubmit} disabled={isPending} className="w-full">
            {isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
