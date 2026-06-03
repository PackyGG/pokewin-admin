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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ux";
import { createGiftCard } from "./actions";

export function CreateGiftCardDialog() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  function handleCreate() {
    const numValue = Number(value);
    if (!numValue || numValue <= 0) {
      toast.error("Please enter a valid value");
      return;
    }
    startTransition(async () => {
      try {
        await createGiftCard({
          value: numValue,
          region: "NA",
          code: code || undefined,
          expiresAt: expiresAt || undefined,
        });
        toast.success("Gift card created");
        setOpen(false);
        setValue("");
        setCode("");
        setExpiresAt("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create gift card");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Create Gift Card</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Gift Card</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Value (USD)</Label>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="10.00"
            />
          </div>
          <div className="space-y-2">
            <Label>Code (optional)</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Auto-generated if empty"
            />
          </div>
          <div className="space-y-2">
            <Label>Expires At (optional)</Label>
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleCreate} disabled={isPending} className="w-full sm:w-auto">
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
