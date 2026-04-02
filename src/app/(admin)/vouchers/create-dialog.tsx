"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createVoucher, searchUsers } from "./actions";

type UserResult = { id: string; username: string | null; email: string | null };

function UserSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (userId: string, label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchUsers(query);
        setResults(res);
        setShowResults(true);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value) onChange("", "");
        }}
        onFocus={() => results.length > 0 && setShowResults(true)}
        placeholder="Search by username or email..."
      />
      {value && (
        <p className="mt-1 text-xs text-muted-foreground">
          Selected: <span className="text-foreground">{value}</span>
        </p>
      )}
      {showResults && results.length > 0 && (
        <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => {
                const label = u.username || u.id.slice(0, 8);
                onChange(u.id, label);
                setQuery(label);
                setShowResults(false);
              }}
            >
              <span className="font-medium">{u.username ?? "No username"}</span>
              <span className="text-xs text-muted-foreground">{u.email}</span>
            </button>
          ))}
        </div>
      )}
      {showResults && query.length >= 2 && results.length === 0 && !searching && (
        <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover p-3 text-center text-sm text-muted-foreground shadow-md">
          No users found
        </div>
      )}
    </div>
  );
}

export function CreateVoucherDialog() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [userLabel, setUserLabel] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");

  function handleCreate() {
    if (!userId.trim()) {
      toast.error("Please select a user");
      return;
    }
    const numValue = Number(value);
    if (!numValue || numValue <= 0) {
      toast.error("Please enter a valid value");
      return;
    }
    startTransition(async () => {
      try {
        await createVoucher({
          userId: userId.trim(),
          value: numValue,
          description: description || undefined,
        });
        toast.success("Voucher created");
        setOpen(false);
        setUserId("");
        setUserLabel("");
        setValue("");
        setDescription("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create voucher");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Create Voucher</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Voucher</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>User</Label>
            <UserSearchInput
              value={userLabel}
              onChange={(id, label) => {
                setUserId(id);
                setUserLabel(label);
              }}
            />
          </div>
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
            <Label>Description (optional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Reason for voucher..."
            />
          </div>
          <Button onClick={handleCreate} disabled={isPending} className="w-full">
            {isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
