"use client";

import { useRef, useState } from "react";
import type { TrelloLabel, TrelloList, TrelloMember } from "@/lib/trello";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Plus, X } from "lucide-react";
import { addAttachmentAction, createCardAction } from "./actions";

const LABEL_COLORS: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-purple-500",
  blue: "bg-blue-500",
  sky: "bg-sky-400",
  lime: "bg-lime-500",
  pink: "bg-pink-500",
  black: "bg-neutral-800",
  blue_dark: "bg-blue-700",
  orange_dark: "bg-orange-700",
  red_dark: "bg-red-700",
  purple_dark: "bg-purple-700",
  red_light: "bg-red-300",
};

export function CreateCardDialog({
  listId,
  labels,
  lists,
  members,
}: {
  listId: string;
  labels: TrelloLabel[];
  lists: TrelloList[];
  members: TrelloMember[];
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [targetList, setTargetList] = useState(listId);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function toggleLabel(id: string) {
    setSelectedLabels((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  function toggleMember(id: string) {
    setSelectedMembers((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImagePreview(url);
  }

  function removeImage() {
    setImageFile(null);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleOpen(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen) {
      setSelectedLabels([]);
      setSelectedMembers([]);
      setTargetList(listId);
      removeImage();
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const name = fd.get("name") as string;
    const desc = fd.get("desc") as string;
    const due = fd.get("due") as string;

    try {
      const card = await createCardAction({
        idList: targetList,
        name,
        desc: desc || undefined,
        due: due || undefined,
        idLabels: selectedLabels.length > 0 ? selectedLabels : undefined,
        idMembers: selectedMembers.length > 0 ? selectedMembers : undefined,
      });
      if (imageFile && card) {
        const attachFd = new FormData();
        attachFd.append("file", imageFile);
        await addAttachmentAction(card.id, attachFd);
      }
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 mb-1 justify-start gap-1 text-muted-foreground"
          />
        }
      >
        <Plus className="h-4 w-4" />
        Add Card
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Card</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="card-name">Title</Label>
            <Input
              id="card-name"
              name="name"
              required
              placeholder="Card title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="card-desc">Description</Label>
            <Textarea
              id="card-desc"
              name="desc"
              placeholder="Optional description"
              rows={3}
            />
          </div>

          {/* Image */}
          <div className="space-y-2">
            <Label>Image</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              className="hidden"
            />
            {imagePreview ? (
              <div className="relative">
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-full max-h-40 object-cover rounded-lg"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80 transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 w-full rounded-lg border border-dashed border-muted-foreground/30 px-4 py-3 text-sm text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground transition-colors"
              >
                <ImagePlus className="h-4 w-4" />
                Add cover image
              </button>
            )}
          </div>

          {/* Labels */}
          <div className="space-y-2">
            <Label>Labels</Label>
            <div className="flex flex-wrap gap-2">
              {labels
                .filter((l) => l.name)
                .map((label) => {
                  const selected = selectedLabels.includes(label.id);
                  return (
                    <button
                      key={label.id}
                      type="button"
                      onClick={() => toggleLabel(label.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                        selected
                          ? "ring-2 ring-primary ring-offset-2"
                          : "opacity-60 hover:opacity-100"
                      }`}
                    >
                      <span
                        className={`h-3 w-3 rounded-full ${LABEL_COLORS[label.color] || "bg-gray-400"}`}
                      />
                      {label.name}
                    </button>
                  );
                })}
            </div>
          </div>

          {/* Members */}
          <div className="space-y-2">
            <Label>Members</Label>
            <div className="flex flex-wrap gap-2">
              {members.map((member) => {
                const selected = selectedMembers.includes(member.id);
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => toggleMember(member.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                      selected
                        ? "ring-2 ring-primary ring-offset-2"
                        : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground shrink-0">
                      {member.initials}
                    </span>
                    {member.fullName}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="card-due">Due Date</Label>
              <Input id="card-due" name="due" type="date" />
            </div>
            <div className="space-y-2">
              <Label>List</Label>
              <select
                value={targetList}
                onChange={(e) => setTargetList(e.target.value)}
                className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Adding..." : "Add"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
