"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Upload,
  Image as ImageIcon,
  FileText,
  Coins,
  Loader2,
  X,
  Sparkles,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createCard } from "./actions";
import { uploadImageClient } from "@/lib/upload-image-client";
import { toastActionError } from "@/lib/utils/action-error";
import {
  ONEPIECE_RARITY_OPTIONS,
  ONEPIECE_CARD_TYPE_OPTIONS,
  isOnePieceSetName,
} from "./_constants/onepiece";

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
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onClear}
            >
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
      <p className="text-[11px] text-muted-foreground">PNG, JPG, WebP · up to 5 MB</p>
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

// Pokemon rarities — unchanged from the pre-OnePiece-fork version of
// this dialog. The OnePiece branch uses its own canonical short-code
// list (C / UC / R / L / SR / SEC / SP / TR / P) from _constants.
const POKEMON_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Ultra Rare",
  "Secret",
] as const;

const POKEMON_CARD_TYPES = ["card", "promo", "special"] as const;

export function CreateCardButton({
  sets,
  defaultSetId = "",
}: {
  sets: { id: string; name: string }[];
  /**
   * Pre-selects the Set dropdown when the dialog opens. Driven by the
   * active per-set tab on /cards — if the admin is browsing the OnePiece
   * tab, the new card defaults to the OnePiece set so the dropdown isn't
   * a fresh "Select set…" prompt every time. Empty string (the default)
   * means no preselection.
   */
  defaultSetId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Shared fields
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [artist, setArtist] = useState("");
  const [tcgplayerId, setTcgplayerId] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [setId, setSetId] = useState(defaultSetId);

  // Pokemon-specific fields. Rarity defaults to "Common" for Pokemon
  // and gets re-defaulted to "C" the moment the operator flips to an
  // OnePiece set — the variant useMemo below picks the right initial
  // value from POKEMON_RARITIES / ONEPIECE_RARITY_OPTIONS.
  const [hp, setHp] = useState("0");
  const [pokemonRarity, setPokemonRarity] = useState<string>("Common");
  const [pokemonType, setPokemonType] = useState<string>("card");

  // OnePiece-specific fields. Empty strings keep the inputs controlled
  // without forcing a default value the operator didn't pick.
  const [cost, setCost] = useState("");
  const [power, setPower] = useState("");
  const [opRarity, setOpRarity] = useState<string>("C");
  const [opType, setOpType] = useState<string>("Character");

  // Both variants use the ImageKit upload flow (file → CDN URL). We
  // track the selected file and its object-URL preview here.
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Resolve the currently-selected set's name → variant. When `setId`
  // is empty the dialog falls back to the Pokemon block (it's the
  // catalog default; OnePiece is the explicit opt-in).
  const variant = useMemo<"pokemon" | "onepiece">(() => {
    const selected = sets.find((s) => s.id === setId);
    return isOnePieceSetName(selected?.name) ? "onepiece" : "pokemon";
  }, [sets, setId]);

  function resetForm() {
    setName("");
    setPrice("");
    setArtist("");
    setTcgplayerId("");
    setCardNumber("");
    // Reset to the active-tab default rather than blank — opening the
    // dialog a second time on the same tab should keep that tab's set
    // pre-selected, not blank it out.
    setSetId(defaultSetId);

    setHp("0");
    setPokemonRarity("Common");
    setPokemonType("card");

    setCost("");
    setPower("");
    setOpRarity("C");
    setOpType("Character");

    setImageFile(null);
    setImagePreview(null);
  }

  // Form validity — the submit button stays disabled until the required
  // fields are filled. Both variants now upload a file via ImageKit, so
  // an uploaded image is required for either.
  const canSubmit = (() => {
    if (!name.trim()) return false;
    return Boolean(imageFile);
  })();

  function handleSubmit() {
    startTransition(async () => {
      try {
        let payloadRarity: string;
        let payloadType: string;
        let payloadHp: number;
        let payloadCost: number | null;
        let payloadPower: number | null;

        // Both variants upload the selected file to ImageKit and submit
        // the resulting hosted URL.
        if (!imageFile) {
          toast.error("Image is required");
          return;
        }
        const imageUrl = await uploadImageClient(imageFile, "/cards");

        if (variant === "pokemon") {
          payloadRarity = pokemonRarity;
          payloadType = pokemonType;
          payloadHp = parseInt(hp) || 0;
          payloadCost = null;
          payloadPower = null;
        } else {
          payloadRarity = opRarity;
          payloadType = opType;
          payloadHp = 0;
          payloadCost = cost.trim() === "" ? null : parseInt(cost);
          payloadPower = power.trim() === "" ? null : parseInt(power);
        }

        const result = await createCard({
          name,
          imageUrl,
          price: parseFloat(price) || 0,
          hp: payloadHp,
          rarity: payloadRarity,
          artist,
          tcgplayerId: tcgplayerId ? parseInt(tcgplayerId) : null,
          type: payloadType,
          cardNumber: cardNumber || null,
          setId: setId || null,
          cost: payloadCost,
          power: payloadPower,
        });

        // Expected failures now come back as a structured result (not a
        // thrown, prod-redacted 500) so the toast shows the REAL cause —
        // "Set not found", "Invalid OnePiece rarity", or the actual
        // Prisma error from the DB.
        if (!result.success) {
          toast.error(result.error);
          return;
        }

        toast.success("Card created");
        setOpen(false);
        resetForm();
        router.refresh();
      } catch (e) {
        // The only throws left are Next's redirect()/notFound() control-flow
        // signals (e.g. expired session → /login from requireAdmin) and the
        // ImageKit upload above. Let redirects navigate cleanly instead of
        // toasting NEXT_REDIRECT; everything else toasts.
        toastActionError(e, "Failed to create card");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        Create Card
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
                <Sparkles className="size-4 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  Create Card
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Add a new card to the catalog.
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
            description="Artwork shown in the catalog and packs."
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
            title="Card details"
            description="Name, set, and rarity metadata."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-card-name">Name</Label>
                <Input
                  id="create-card-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    variant === "onepiece" ? "e.g. Monkey D. Luffy" : "e.g. Charizard"
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-card-rarity">Rarity</Label>
                {variant === "pokemon" ? (
                  <Select
                    value={pokemonRarity}
                    onValueChange={(v) => v && setPokemonRarity(v)}
                  >
                    <SelectTrigger id="create-card-rarity" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POKEMON_RARITIES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={opRarity}
                    onValueChange={(v) => v && setOpRarity(v)}
                  >
                    <SelectTrigger id="create-card-rarity" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ONEPIECE_RARITY_OPTIONS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}{" "}
                          <span className="text-muted-foreground">({r.value})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-card-set">Set</Label>
                <Select value={setId} onValueChange={(v) => setSetId(v ?? "")}>
                  <SelectTrigger id="create-card-set" className="w-full">
                    <SelectValue placeholder="Select set..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {sets.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-card-number">Card Number</Label>
                <Input
                  id="create-card-number"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  placeholder={
                    variant === "onepiece" ? "e.g. OP01-001" : "e.g. 025/198"
                  }
                />
              </div>
            </div>

            {variant === "pokemon" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="create-card-type">Type</Label>
                  <Select
                    value={pokemonType}
                    onValueChange={(v) => v && setPokemonType(v)}
                  >
                    <SelectTrigger id="create-card-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {POKEMON_CARD_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="create-card-hp">HP</Label>
                  <Input
                    id="create-card-hp"
                    type="number"
                    value={hp}
                    onChange={(e) => setHp(e.target.value)}
                    min="0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="create-card-artist">Artist</Label>
                  <Input
                    id="create-card-artist"
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                    placeholder="Artist name"
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="create-card-type">Card type</Label>
                    <Select
                      value={opType}
                      onValueChange={(v) => v && setOpType(v)}
                    >
                      <SelectTrigger id="create-card-type" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ONEPIECE_CARD_TYPE_OPTIONS.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="create-card-cost">Cost</Label>
                    <Input
                      id="create-card-cost"
                      type="number"
                      value={cost}
                      onChange={(e) => setCost(e.target.value)}
                      min="0"
                      max="20"
                      placeholder="Optional"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="create-card-power">Power</Label>
                    <Input
                      id="create-card-power"
                      type="number"
                      value={power}
                      onChange={(e) => setPower(e.target.value)}
                      min="0"
                      max="20000"
                      placeholder="Optional"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="create-card-artist">Artist</Label>
                    <Input
                      id="create-card-artist"
                      value={artist}
                      onChange={(e) => setArtist(e.target.value)}
                      placeholder="Artist name (optional)"
                    />
                  </div>
                </div>
              </>
            )}
          </Section>

          <Section
            icon={Coins}
            title="Economy"
            description="Pricing and external-market reference."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="create-card-price">Price (USD)</Label>
                <Input
                  id="create-card-price"
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-card-tcg">TCGPlayer ID</Label>
                <Input
                  id="create-card-tcg"
                  type="number"
                  value={tcgplayerId}
                  onChange={(e) => setTcgplayerId(e.target.value)}
                  placeholder="Optional"
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
          <Button onClick={handleSubmit} disabled={isPending || !canSubmit}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="size-4" />
                Create card
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
