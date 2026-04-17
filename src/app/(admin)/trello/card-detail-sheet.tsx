"use client";

import { useState, useEffect } from "react";
import type { TrelloCard, TrelloList, TrelloComment } from "@/lib/trello";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageSquare, Send, X } from "lucide-react";
import { toast } from "sonner";
import {
  updateCardAction,
  deleteCardAction,
  getCardCommentsAction,
  addCardCommentAction,
} from "./actions";

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
};

export function CardDetailSheet({
  card,
  lists,
  open,
  onOpenChange,
}: {
  card: TrelloCard | null;
  lists: TrelloList[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [due, setDue] = useState("");
  const [listId, setListId] = useState("");
  const [saving, setSaving] = useState(false);
  const [comments, setComments] = useState<TrelloComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    if (card) {
      setName(card.name);
      // Strip markdown image links from description (they show as attachments)
      const cleanDesc = card.desc.replace(/!\[[^\]]*\]\([^)]+\)\n?/g, "").trim();
      setDesc(cleanDesc);
      setDue(card.due ? card.due.split("T")[0] : "");
      setListId(card.idList);
      setComments([]);
      setNewComment("");
      setLightboxUrl(null);
      // Load comments
      getCardCommentsAction(card.id)
        .then(setComments)
        .catch((err) => {
          console.error("[trello comments]", err);
          toast.error("Failed to load comments");
        });
    }
  }, [card]);

  if (!card) return null;

  async function handleSave() {
    if (!card) return;
    setSaving(true);
    try {
      await updateCardAction(card.id, {
        name,
        desc,
        due: due || null,
        idList: listId !== card.idList ? listId : undefined,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!card) return;
    await deleteCardAction(card.id);
    onOpenChange(false);
  }

  async function handleAddComment() {
    if (!card || !newComment.trim()) return;
    setSendingComment(true);
    try {
      await addCardCommentAction(card.id, newComment.trim());
      setNewComment("");
      // Refresh comments
      const updated = await getCardCommentsAction(card.id);
      setComments(updated);
    } finally {
      setSendingComment(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Edit Card</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_280px] gap-6">
          {/* Left — card details */}
          <div className="space-y-4 min-w-0">
            {/* Labels */}
            {card.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {card.labels.map((label) => (
                  <Badge
                    key={label.id}
                    className={`${LABEL_COLORS[label.color] || "bg-gray-400"} text-white border-0`}
                  >
                    {label.name || label.color}
                  </Badge>
                ))}
              </div>
            )}

            {/* Attachment image */}
            {(() => {
              const img = card.attachments?.find((a) => a.mimeType?.startsWith("image/"));
              const preview = img?.previews?.[img.previews.length - 1];
              const fullUrl = img?.url;
              return preview ? (
                <img
                  src={preview.url}
                  alt=""
                  className="w-full rounded-md object-cover max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setLightboxUrl(fullUrl || preview.url)}
                />
              ) : null;
            })()}

            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={5}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>List</Label>
                <select
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
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

            <div className="flex gap-2 pt-2">
              <Button onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </div>
          </div>

          {/* Right — comments */}
          <div className="space-y-3 border-l pl-4 sm:pl-4 sm:border-l border-border">
            <div className="flex items-center gap-2 text-sm font-medium">
              <MessageSquare className="h-4 w-4" />
              Comments
            </div>

            {/* Add comment */}
            <div className="flex gap-2">
              <Input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleAddComment();
                  }
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 h-9 w-9"
                onClick={handleAddComment}
                disabled={sendingComment || !newComment.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>

            {/* Comments list */}
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {comments.length === 0 ? (
                <p className="text-xs text-muted-foreground">No comments yet.</p>
              ) : (
                comments.map((comment) => (
                  <div key={comment.id} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground shrink-0">
                        {comment.memberCreator.initials}
                      </span>
                      <span className="text-xs font-medium truncate">
                        {comment.memberCreator.fullName}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground pl-8 break-words">
                      {comment.data.text}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 pl-8">
                      {new Date(comment.date).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            className="absolute top-4 right-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 transition-colors"
            onClick={() => setLightboxUrl(null)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightboxUrl}
            alt=""
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
