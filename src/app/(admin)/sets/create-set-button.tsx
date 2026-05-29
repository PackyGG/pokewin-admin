"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Upload,
  Image as ImageIcon,
  FileText,
  CalendarDays,
  Loader2,
  X,
  Library,
} from "lucide-react";
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
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { createSet } from "./actions";
import { uploadImageClient } from "@/lib/upload-image-client";

// ────────────────────────────────────────────────────────────────────
//  Section heading — small, inline, sits inside the dialog body.
// ────────────────────────────────────────────────────────────────────
function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary/10">
          <Icon className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="space-y-3 pl-8">{children}</div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────
//  Image dropzone — compact drop area + preview with replace button.
// ────────────────────────────────────────────────────────────────────
function ImageDropzone({
  preview,
  onFile,
  onClear,
}: {
  preview: string | null;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (file.type.startsWith("image/")) onFile(file);
    },
    [onFile],
  );

  if (preview) {
    return (
      <div className="flex items-start gap-4 rounded-xl border bg-card/50 p-3">
        <div className="relative shrink-0 overflow-hidden rounded-lg ring-1 ring-border bg-muted/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Preview"
            className="h-24 w-[72px] object-cover"
          />
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-xs font-medium">Image selected</p>
          <p className="text-[11px] text-muted-foreground">
            Click replace to pick a different file.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="size-3" />
              Replace
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={onClear}>
              <X className="size-3" />
              Remove
            </Button>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center",
        "motion-safe:transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-muted/30",
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
        <Upload className="size-4 text-primary" />
      </div>
      <p className="text-sm">
        <span className="font-medium">Click to upload</span>
        <span className="text-muted-foreground"> or drag and drop</span>
      </p>
      <p className="text-[11px] text-muted-foreground">
        PNG, JPG, WebP · up to 5 MB
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}

export function CreateSetButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [name, setName] = useState("");
  const [series, setSeries] = useState("");
  const [language, setLanguage] = useState("en");
  const [tcgplayerId, setTcgplayerId] = useState("");
  const [releaseDate, setReleaseDate] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  function resetForm() {
    setName("");
    setSeries("");
    setLanguage("en");
    setTcgplayerId("");
    setReleaseDate("");
    setImageFile(null);
    setImagePreview(null);
  }

  function handleSubmit() {
    startTransition(async () => {
      try {
        if (!imageFile) {
          toast.error("Image is required");
          return;
        }
        const parsedTcg = parseInt(tcgplayerId, 10);
        if (!Number.isInteger(parsedTcg)) {
          toast.error("TCGPlayer ID must be a whole number");
          return;
        }

        const imageUrl = await uploadImageClient(imageFile, "/sets");

        await createSet({
          name,
          series,
          imageUrl,
          language,
          tcgplayerId: parsedTcg,
          releaseDate: releaseDate || null,
        });

        toast.success("Set created");
        setOpen(false);
        resetForm();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create set");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        Create Set
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* Header band — gradient to match the hero aesthetic. */}
        <div className="relative overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-card via-card to-card/60 px-5 py-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-blue-500/[0.06] blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 -bottom-16 size-48 rounded-full bg-purple-500/[0.06] blur-3xl"
          />
          <DialogHeader className="relative">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <Library className="size-4 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Create Set
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Add a new set / series (e.g. One Piece) to the catalog.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Body — three sections. */}
        <div className="space-y-6 px-5 py-5">
          <Section
            icon={ImageIcon}
            title="Image"
            description="Set logo shown in the catalog and filters."
          >
            <ImageDropzone
              preview={imagePreview}
              onFile={(file) => {
                setImageFile(file);
                setImagePreview(URL.createObjectURL(file));
              }}
              onClear={() => {
                setImageFile(null);
                setImagePreview(null);
              }}
            />
          </Section>

          <Section
            icon={FileText}
            title="Set details"
            description="Name, series, and language metadata."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-set-name">Name</Label>
                <Input
                  id="create-set-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Romance Dawn"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-set-series">Series</Label>
                <Input
                  id="create-set-series"
                  value={series}
                  onChange={(e) => setSeries(e.target.value)}
                  placeholder="e.g. One Piece"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-set-language">Language</Label>
                <Input
                  id="create-set-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="e.g. en"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-set-tcg">TCGPlayer ID</Label>
                <Input
                  id="create-set-tcg"
                  type="number"
                  value={tcgplayerId}
                  onChange={(e) => setTcgplayerId(e.target.value)}
                  placeholder="Unique integer"
                />
              </div>
            </div>
          </Section>

          <Section
            icon={CalendarDays}
            title="Release"
            description="Optional release date for the set."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-set-release">Release date</Label>
                <Input
                  id="create-set-release"
                  type="date"
                  value={releaseDate}
                  onChange={(e) => setReleaseDate(e.target.value)}
                />
              </div>
            </div>
          </Section>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              isPending ||
              !name ||
              !series ||
              !language ||
              !tcgplayerId ||
              !imageFile
            }
          >
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="size-4" />
                Create set
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
