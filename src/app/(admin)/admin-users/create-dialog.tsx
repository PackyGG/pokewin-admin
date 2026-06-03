"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ALL_ADMIN_ROLES, type AdminRole } from "@/lib/admin-roles";
import { createAdminUser } from "./actions";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Spinner, transition } from "@/components/ux";

const ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Admin",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
  pack_creator: "Pack Creator",
};

export function CreateAdminDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // A new admin can be created with one OR several roles. Default to
  // support — the most common hire — matching the previous single-select
  // default.
  const [roles, setRoles] = useState<Set<AdminRole>>(
    () => new Set<AdminRole>(["support"]),
  );

  function toggle(role: AdminRole) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  function resetForm() {
    setRoles(new Set<AdminRole>(["support"]));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (roles.size === 0) {
      toast.error("Pick at least one role.");
      return;
    }
    setLoading(true);

    const form = new FormData(e.currentTarget);
    // ServerActionResult contract — no try/catch around the call. The
    // action never throws across the RSC boundary; it returns
    // `{ success, error?, data? }` and we branch on it.
    const result = await createAdminUser({
      email: form.get("email") as string,
      username: form.get("username") as string,
      password: form.get("password") as string,
      roles: [...roles],
    });
    setLoading(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Admin user created");
    resetForm();
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetForm();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="mr-2 size-4" />
        Add Admin
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Admin User</DialogTitle>
        </DialogHeader>
        <form
          id="create-admin-form"
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required minLength={8} />
          </div>
          <div className="space-y-2">
            <Label>Roles</Label>
            <p className="text-xs text-muted-foreground">
              A user can hold several roles at once and gets the combined
              access of all of them.
            </p>
            <div className="space-y-1.5">
              {ALL_ADMIN_ROLES.map((r) => {
                const checked = roles.has(r);
                return (
                  <label
                    key={r}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md border p-2.5",
                      transition("colors", "fast"),
                      checked
                        ? "border-primary/40 bg-primary/5"
                        : "border-input hover:bg-accent/40",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(r)}
                    />
                    <span className="text-sm font-medium">{ROLE_LABELS[r]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button
            type="submit"
            form="create-admin-form"
            disabled={loading || roles.size === 0}
            className="w-full sm:w-auto"
          >
            {loading && <Spinner size={14} className="text-current" />}
            {loading ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
