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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogFooter } from "@/components/ui/dialog";
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
import {
  parseTcgplayerProductId,
  TCGPLAYER_LINK_ERROR,
} from "./_constants/tcgplayer";

/**
 * Heavy body of the "Create Card" dialog, split out of <CreateCardButton>
 * so it can be `React.lazy()`-loaded on first open. Keeps the image-upload
 * flow, the Pokemon/OnePiece variant branches, and all the selects out of
 * the /cards route chunk. Behavior + numbers are identical to the previous
 * inline implementation.
 *
 * `onClose` closes the parent dialog (after a successful create or Cancel).
 */

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

export function CreateCardForm({
  sets,
  defaultSetId = "",
  onClose,
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
  onClose: () => void;
}) {
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
  //
  // `opLife` is OnePiece's "Life" stat. There is no dedicated `life`
  // column on the cards table (see the MAIN Drizzle schema — only hp / cost
  // / power exist), so Life persists into the existing `hp` Int column.
  // Pokemon still write their own `hp` from the `hp` state above; the two
  // never overlap because the variant branch picks exactly one.
  //
  // `power` is a free-typed input (matches the requested "string" field
  // UX) but the `cards.power` column is `Int?`, so it's parsed to an int
  // on submit. Non-numeric values would need a schema migration.
  //
  // `cost` was removed from the OnePiece create form per product request —
  // the column stays in the DB but new OnePiece cards leave it null.
  const [opLife, setOpLife] = useState("");
  const [power, setPower] = useState("");
  const [opRarity, setOpRarity] = useState<string>("C");
  const [opType, setOpType] = useState<string>("Character");

  // OnePiece TCGplayer reference is captured as the full product LINK (the
  // operator pastes the tcgplayer.com URL). We parse the numeric product id
  // out of it and store that in the existing `cards.tcgplayer_id Int?`
  // column — there is no url/text column to keep the full URL, so the slug
  // is dropped and the canonical link is reconstructed from the id on the
  // detail page. Required for OnePiece. The Pokemon branch keeps using the
  // numeric `tcgplayerId` state below (optional, raw id).
  const [tcgLink, setTcgLink] = useState("");

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

  // value → label map for the Set <Select>. base-ui's <Select.Value>
  // renders the raw `value` (here a set UUID) unless it can look the
  // value up in an `items` map — without this the trigger shows the
  // pre-selected set's UUID instead of its name while the popup is
  // closed (the bug: opening the dialog from the OnePiece tab showed
  // a "weird id" rather than "OnePiece"). Keyed by id so the resolver
  // maps `defaultSetId` straight to the set name on first render.
  const setItems = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const s of sets) map[s.id] = s.name;
    return map;
  }, [sets]);

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

    setOpLife("");
    setPower("");
    setOpRarity("C");
    setOpType("Character");
    setTcgLink("");

    setImageFile(null);
    setImagePreview(null);
  }

  // Form validity — the submit button stays disabled until the required
  // fields are filled. Both variants now upload a file via ImageKit, so
  // an uploaded image is required for either. OnePiece additionally
  // requires a valid TCGplayer product LINK (parsed to a product id on
  // submit); Pokemon's TCGplayer id stays optional.
  const canSubmit = (() => {
    if (!name.trim()) return false;
    if (!imageFile) return false;
    if (variant === "onepiece" && parseTcgplayerProductId(tcgLink) == null) {
      return false;
    }
    return true;
  })();

  function handleSubmit() {
    startTransition(async () => {
      try {
        let payloadRarity: string;
        let payloadType: string;
        let payloadHp: number;
        let payloadCost: number | null;
        let payloadPower: number | null;
        // TCGplayer reference stored as a product id (Int). For OnePiece
        // it's parsed from the pasted product LINK and is required; for
        // Pokemon it's the optional raw numeric id.
        let payloadTcgplayerId: number | null;

        // Both variants upload the selected file to ImageKit and submit
        // the resulting hosted URL.
        if (!imageFile) {
          toast.error("Image is required");
          return;
        }

        if (variant === "pokemon") {
          payloadRarity = pokemonRarity;
          payloadType = pokemonType;
          payloadHp = parseInt(hp) || 0;
          payloadCost = null;
          payloadPower = null;
          payloadTcgplayerId = tcgplayerId ? parseInt(tcgplayerId) : null;
        } else {
          payloadRarity = opRarity;
          payloadType = opType;
          // OnePiece "Life" persists into the `hp` column (no dedicated
          // `life` column exists). Cost is intentionally not written for
          // OnePiece cards anymore (field removed); leave it null. Power
          // is a free-typed field parsed to the `power` Int column.
          payloadHp = parseInt(opLife) || 0;
          payloadCost = null;
          payloadPower = power.trim() === "" ? null : parseInt(power);
          // OnePiece requires a valid TCGplayer product LINK. Parse the
          // product id out of the URL before we spend an ImageKit upload;
          // the server re-validates this (authoritative). The slug is not
          // kept — only the integer id is stored in `tcgplayer_id`.
          const parsedTcg = parseTcgplayerProductId(tcgLink);
          if (parsedTcg == null) {
            toast.error(TCGPLAYER_LINK_ERROR);
            return;
          }
          payloadTcgplayerId = parsedTcg;
        }

        const imageUrl = await uploadImageClient(imageFile, "/cards");

        const result = await createCard({
          name,
          imageUrl,
          price: parseFloat(price) || 0,
          hp: payloadHp,
          rarity: payloadRarity,
          artist,
          tcgplayerId: payloadTcgplayerId,
          type: payloadType,
          cardNumber: cardNumber || null,
          setId: setId || null,
          cost: payloadCost,
          power: payloadPower,
        });

        // Expected failures now come back as a structured result (not a
        // thrown, prod-redacted 500) so the toast shows the REAL cause —
        // "Set not found", "Invalid OnePiece rarity", or the actual
        // Database error.
        if (!result.success) {
          toast.error(result.error);
          return;
        }

        toast.success("Card created");
        onClose();
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
    <>
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
              <Select
                items={setItems}
                value={setId}
                onValueChange={(v) => setSetId(v ?? "")}
              >
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
                  <Label htmlFor="create-card-life">Life</Label>
                  <Input
                    id="create-card-life"
                    type="number"
                    value={opLife}
                    onChange={(e) => setOpLife(e.target.value)}
                    min="0"
                    placeholder="Optional"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="create-card-power">Power</Label>
                  <Input
                    id="create-card-power"
                    value={power}
                    onChange={(e) => setPower(e.target.value)}
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
            {variant === "onepiece" ? (
              // OnePiece: a REQUIRED TCGplayer product link. The product id
              // is parsed out of the URL on submit and stored in
              // `tcgplayer_id`; only the id is kept (slug is dropped).
              <div className="space-y-1.5">
                <Label htmlFor="create-card-tcg-link">TCGplayer Link</Label>
                <Input
                  id="create-card-tcg-link"
                  type="url"
                  inputMode="url"
                  value={tcgLink}
                  onChange={(e) => setTcgLink(e.target.value)}
                  placeholder="https://www.tcgplayer.com/product/517800/..."
                  aria-required="true"
                  aria-invalid={
                    tcgLink.trim() !== "" &&
                    parseTcgplayerProductId(tcgLink) == null
                  }
                />
                {tcgLink.trim() !== "" &&
                parseTcgplayerProductId(tcgLink) == null ? (
                  <p className="text-[11px] text-rose-600 dark:text-rose-400">
                    {TCGPLAYER_LINK_ERROR}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Paste the TCGplayer product URL. Required for OnePiece.
                  </p>
                )}
              </div>
            ) : (
              // Pokemon: unchanged — optional raw numeric TCGplayer id.
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
            )}
          </div>
        </Section>
      </div>

      <DialogFooter>
        <Button
          variant="ghost"
          onClick={onClose}
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
    </>
  );
}
