"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Send, Copy } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  createCreatorWebhook,
  updateCreatorWebhook,
  deleteCreatorWebhook,
  testCreatorWebhook,
} from "./actions";

type Webhook = {
  id: string;
  url: string;
  type: string;
  enabled: boolean;
  createdAt: string;
};

export function CreatorWebhooksCard({ webhooks }: { webhooks: Webhook[] }) {
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdd() {
    if (!newUrl.trim()) return;
    startTransition(async () => {
      try {
        const result = await createCreatorWebhook({ url: newUrl });
        setCreatedSecret(result.secret);
        toast.success("Webhook created");
        setNewUrl("");
        setAdding(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create webhook");
      }
    });
  }

  function handleDelete(webhookId: string) {
    startTransition(async () => {
      try {
        await deleteCreatorWebhook(webhookId);
        toast.success("Webhook deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete webhook");
      }
    });
  }

  function handleToggle(webhookId: string, enabled: boolean) {
    startTransition(async () => {
      try {
        await updateCreatorWebhook(webhookId, { enabled });
        toast.success(enabled ? "Webhook enabled" : "Webhook disabled");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update webhook");
      }
    });
  }

  function handleTest(webhookId: string) {
    startTransition(async () => {
      try {
        const result = await testCreatorWebhook(webhookId);
        if (result.success) {
          toast.success(`Test sent — Status ${result.status}`);
        } else {
          toast.error(`Test failed — ${result.error ?? `Status ${result.status}`}`);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to test webhook");
      }
    });
  }

  function copySecret() {
    if (createdSecret) {
      navigator.clipboard.writeText(createdSecret);
      toast.success("Secret copied to clipboard");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Webhooks</CardTitle>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 size-3.5" />
            Add Webhook
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {createdSecret && (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
            <p className="mb-1 text-xs font-medium text-yellow-600 dark:text-yellow-400">
              Webhook secret (shown only once):
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all text-xs">{createdSecret}</code>
              <Button variant="ghost" size="icon" className="size-7" onClick={copySecret}>
                <Copy className="size-3.5" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-xs"
              onClick={() => setCreatedSecret(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {webhooks.map((w) => (
          <div key={w.id} className="flex items-center justify-between rounded-md border p-3">
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={w.url}>
              {w.url}
            </span>
            <div className="flex items-center gap-2">
              <Switch
                checked={w.enabled}
                onCheckedChange={(enabled) => handleToggle(w.id, enabled)}
                disabled={isPending}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => handleTest(w.id)}
                disabled={isPending}
                title="Send test"
              >
                <Send className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-destructive hover:text-destructive"
                onClick={() => handleDelete(w.id)}
                disabled={isPending}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}

        {webhooks.length === 0 && !adding && (
          <p className="py-4 text-center text-sm text-muted-foreground">No webhooks configured.</p>
        )}

        {adding && (
          <div className="space-y-2 rounded-md border p-3">
            <Input
              placeholder="https://example.com/webhook"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              className="h-8 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") { setAdding(false); setNewUrl(""); }
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={isPending}>
                {isPending ? "Creating..." : "Create"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setNewUrl(""); }} disabled={isPending}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
