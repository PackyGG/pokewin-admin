"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PackEditForm, type PackEditData } from "../pack-edit-form";

export function EditPackButton({
  pack,
  defaultOpen = false,
  onClosed,
  onSaved,
}: {
  pack: PackEditData;
  defaultOpen?: boolean;
  onClosed?: () => void;
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) onClosed?.();
      }}
    >
      {!defaultOpen && (
        <DialogTrigger render={<Button size="sm" variant="outline" />}>
          <Pencil className="mr-1 size-3.5" />
          Edit
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit Pack</DialogTitle>
        </DialogHeader>
        <PackEditForm
          key={pack.id}
          pack={pack}
          onCancel={() => setOpen(false)}
          onSaved={() => {
            onSaved?.();
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
