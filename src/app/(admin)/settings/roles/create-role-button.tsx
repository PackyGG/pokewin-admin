"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createRole } from "./custom-roles-actions";

export function CreateRoleButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function reset() {
    setName("");
    setDescription("");
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await createRole({
        name,
        description: description.trim() || null,
        capabilities: [],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Role created");
      setOpen(false);
      reset();
      router.push(`/settings/roles/${result.id}`);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        New Role
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create custom role</DialogTitle>
          <DialogDescription>
            Creates an empty role. You&apos;ll be redirected to the editor to pick
            capabilities.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Support L2"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-description">Description (optional)</Label>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name.trim()}
            className="w-full sm:w-auto"
          >
            {isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
