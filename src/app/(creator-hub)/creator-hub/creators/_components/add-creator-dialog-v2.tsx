"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Code,
  ImageIcon,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_COLORS } from "@/lib/constants";

import {
  searchNonCreatorUsers,
  type NonCreatorCandidate,
} from "../../../../(admin)/creators/_queries/search-non-creator-users";
import {
  addAffiliateCode,
  removeAffiliateCode,
} from "../../../../(admin)/creators/actions";
import { SetAffiliateCodeDialog } from "../../../../(admin)/users/[id]/user-tabs-creator";
import {
  completeCreatorOnboarding,
  getCandidateSetupProfile,
  type CandidateSetupProfile,
} from "../_actions/add-creator-setup";

const MIN_SEARCH_LENGTH = 2;
const DEBOUNCE_MS = 250;

type Step = "search" | "profile";

export function AddCreatorDialogV2() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NonCreatorCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [candidate, setCandidate] = useState<CandidateSetupProfile | null>(
    null,
  );
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [isSubmitting, startSubmit] = useTransition();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Profile form fields
  const [discordId, setDiscordId] = useState("");
  const [discordChannelUrl, setDiscordChannelUrl] = useState("");
  const [twitter, setTwitter] = useState("");
  const [kick, setKick] = useState("");
  const [rewardPageUrl, setRewardPageUrl] = useState("");
  const [codes, setCodes] = useState<{ id: string; code: string }[]>([]);
  const [newCode, setNewCode] = useState("");
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [localPfpPreview, setLocalPfpPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!open || step !== "search") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const reqId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const found = await searchNonCreatorUsers(trimmed);
        if (reqId === requestIdRef.current) setResults(found);
      } catch (err) {
        if (reqId === requestIdRef.current) {
          setResults([]);
          toast.error(
            err instanceof Error ? err.message : "Search failed",
          );
        }
      } finally {
        if (reqId === requestIdRef.current) setIsSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, step]);

  useEffect(() => {
    return () => {
      if (localPfpPreview) URL.revokeObjectURL(localPfpPreview);
    };
  }, [localPfpPreview]);

  useEffect(() => {
    if (codeDialogOpen || !candidate) return;
    void getCandidateSetupProfile(candidate.userId).then((profile) => {
      if (profile) setCodes(profile.codes);
    });
  }, [codeDialogOpen, candidate]);

  function reset() {
    setStep("search");
    setQuery("");
    setResults([]);
    setIsSearching(false);
    setCandidate(null);
    setDiscordId("");
    setDiscordChannelUrl("");
    setTwitter("");
    setKick("");
    setRewardPageUrl("");
    setCodes([]);
    setNewCode("");
    if (localPfpPreview) URL.revokeObjectURL(localPfpPreview);
    setLocalPfpPreview(null);
  }

  async function selectCandidate(c: NonCreatorCandidate) {
    setLoadingProfile(true);
    try {
      const profile = await getCandidateSetupProfile(c.userId);
      if (!profile) {
        toast.error("User not found or already a creator");
        return;
      }
      setCandidate(profile);
      setCodes(profile.codes);
      setStep("profile");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not load user profile",
      );
    } finally {
      setLoadingProfile(false);
    }
  }

  function handlePfpFile(file: File | null) {
    if (localPfpPreview) URL.revokeObjectURL(localPfpPreview);
    if (!file) {
      setLocalPfpPreview(null);
      return;
    }
    setLocalPfpPreview(URL.createObjectURL(file));
  }

  function handleAddCode() {
    if (!candidate) return;
    const trimmed = newCode.trim();
    if (!trimmed) {
      toast.error("Enter a code");
      return;
    }
    startSubmit(async () => {
      try {
        await addAffiliateCode(candidate.userId, trimmed);
        setCodes((prev) => [...prev, { id: `new-${trimmed}`, code: trimmed }]);
        setNewCode("");
        toast.success(`Code "${trimmed}" added`);
        const refreshed = await getCandidateSetupProfile(candidate.userId);
        if (refreshed) setCodes(refreshed.codes);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to add code");
      }
    });
  }

  function handleRemoveCode(codeId: string, codeLabel: string) {
    if (!candidate) return;
    startSubmit(async () => {
      try {
        await removeAffiliateCode(codeId);
        setCodes((prev) => prev.filter((c) => c.id !== codeId));
        toast.success(`Code "${codeLabel}" removed`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to remove code");
      }
    });
  }

  function handlePromote() {
    if (!candidate) return;
    if (!discordId.trim()) {
      toast.error("Discord ID is required");
      return;
    }
    if (!discordChannelUrl.trim()) {
      toast.error("Discord channel link is required");
      return;
    }

    startSubmit(async () => {
      try {
        const result = await completeCreatorOnboarding({
          userId: candidate.userId,
          discordId: discordId.trim(),
          discordChannelUrl: discordChannelUrl.trim(),
          twitter: twitter.trim() || undefined,
          kick: kick.trim() || undefined,
          rewardPageUrl: rewardPageUrl.trim() || "",
        });
        toast.success(
          `${candidate.username ?? candidate.email ?? "User"} is now a creator`,
        );
        setOpen(false);
        reset();
        router.push(`/creator-hub/creators/${result.userId}`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to create creator",
        );
      }
    });
  }

  const displayName =
    candidate?.username ?? candidate?.email ?? "Selected user";
  const pfpSrc = localPfpPreview ?? candidate?.image ?? null;
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <UserPlus className="mr-2 size-4" />
        Add Creator
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            {step === "search" ? "Add creator" : "Profile setup"}
          </DialogTitle>
          <DialogDescription>
            {step === "search"
              ? "Search for a user, then set up their creator profile before promoting."
              : `Configure socials and codes for ${displayName}, then promote.`}
          </DialogDescription>
        </DialogHeader>

        {step === "search" ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Username or email..."
                className="pl-9"
              />
              {(isSearching || loadingProfile) && (
                <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="min-h-[120px] rounded-md border divide-y">
              {query.trim().length < MIN_SEARCH_LENGTH ? (
                <EmptyState message="Type at least 2 characters to search." />
              ) : isSearching && results.length === 0 ? (
                <EmptyState message="Searching..." />
              ) : results.length === 0 ? (
                <EmptyState message="No non-creator users match your search." />
              ) : (
                results.map((c) => (
                  <CandidateRow
                    key={c.userId}
                    candidate={c}
                    disabled={loadingProfile || isSubmitting}
                    onSelect={() => selectCandidate(c)}
                  />
                ))
              )}
            </div>
          </div>
        ) : (
          candidate && (
            <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                <Avatar className="size-12 shrink-0">
                  {pfpSrc && <AvatarImage src={pfpSrc} alt="" />}
                  <AvatarFallback className="text-xs font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{displayName}</p>
                  {candidate.email && (
                    <p className="truncate text-xs text-muted-foreground">
                      {candidate.email}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <ImageIcon className="size-3.5" />
                  PFP preview (admin only)
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Local preview only — does not write to packy.gg.
                </p>
                <Input
                  type="file"
                  accept="image/*"
                  disabled={isSubmitting}
                  onChange={(e) =>
                    handlePfpFile(e.target.files?.[0] ?? null)
                  }
                  className="h-8 text-xs"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Discord ID *"
                  value={discordId}
                  onChange={setDiscordId}
                  placeholder="Discord ID or username"
                  disabled={isSubmitting}
                />
                <Field
                  label="Discord channel *"
                  value={discordChannelUrl}
                  onChange={setDiscordChannelUrl}
                  placeholder="https://discord.com/channels/…"
                  disabled={isSubmitting}
                  className="sm:col-span-2"
                />
                <Field
                  label="Twitter / X"
                  value={twitter}
                  onChange={setTwitter}
                  placeholder="handle"
                  disabled={isSubmitting}
                />
                <Field
                  label="Kick"
                  value={kick}
                  onChange={setKick}
                  placeholder="channel slug"
                  disabled={isSubmitting}
                />
                <Field
                  label="Reward page"
                  value={rewardPageUrl}
                  onChange={setRewardPageUrl}
                  placeholder="https://packy.gg/r/…"
                  disabled={isSubmitting}
                  className="sm:col-span-2"
                />
              </div>

              <div className="space-y-2 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Code className="size-3.5" />
                    Affiliate codes
                  </Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setCodeDialogOpen(true)}
                    disabled={isSubmitting}
                  >
                    Steal / set code
                  </Button>
                </div>

                <div className="space-y-1">
                  {codes.length === 0 ? (
                    <p className="rounded-md border border-dashed px-2 py-2 text-center text-xs text-muted-foreground">
                      No codes yet — add one below or use Steal / set code.
                    </p>
                  ) : (
                    codes.map((c, i) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-xs font-semibold">
                            {c.code}
                          </span>
                          {i === 0 && (
                            <Badge
                              variant="outline"
                              className="text-[9px] uppercase"
                            >
                              Primary
                            </Badge>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6 text-muted-foreground hover:text-rose-500"
                          onClick={() => handleRemoveCode(c.id, c.code)}
                          disabled={isSubmitting}
                          aria-label={`Remove ${c.code}`}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex gap-1.5">
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    placeholder="newcode"
                    className="h-8 font-mono text-xs"
                    maxLength={32}
                    disabled={isSubmitting}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddCode();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={handleAddCode}
                    disabled={isSubmitting || !newCode.trim()}
                  >
                    <Plus className="size-3.5" />
                    Add
                  </Button>
                </div>
              </div>

              <SetAffiliateCodeDialog
                open={codeDialogOpen}
                onOpenChange={setCodeDialogOpen}
                userId={candidate.userId}
                currentUsername={candidate.username ?? candidate.email}
              />
            </div>
          )
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === "profile" ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("search")}
                disabled={isSubmitting}
              >
                <ArrowLeft className="mr-1.5 size-3.5" />
                Back
              </Button>
              <Button
                type="button"
                onClick={handlePromote}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <Loader2 className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <ArrowRight className="mr-1.5 size-4" />
                )}
                Promote creator
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="mt-1 h-8"
      />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function CandidateRow({
  candidate,
  disabled,
  onSelect,
}: {
  candidate: NonCreatorCandidate;
  disabled: boolean;
  onSelect: () => void;
}) {
  const primary = candidate.username ?? candidate.email ?? "(no name)";
  const secondary =
    candidate.username && candidate.email ? candidate.email : null;

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{primary}</span>
          <Badge
            variant="outline"
            className={ROLE_COLORS[candidate.role] ?? ""}
          >
            {candidate.role}
          </Badge>
        </div>
        {secondary && (
          <div className="truncate text-xs text-muted-foreground">
            {secondary}
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={onSelect} disabled={disabled}>
        Select
      </Button>
    </div>
  );
}
