"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { updateUserPermissions } from "./actions";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Permissions Section ── */
export function PermissionsSection({ detail }: { detail: AdminUserDetail }) {
  const [pages, setPages] = useState<string[]>(detail.allowedPages);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const groups = ADMIN_PAGES.reduce<Record<string, typeof ADMIN_PAGES>>((acc, page) => {
    (acc[page.group] ??= []).push(page);
    return acc;
  }, {});

  function toggle(key: string) {
    const next = pages.includes(key) ? pages.filter((p) => p !== key) : [...pages, key];
    setPages(next);
    save(next);
  }

  function toggleGroup(group: string) {
    const groupKeys = groups[group].map((p) => p.key);
    const allChecked = groupKeys.every((k) => pages.includes(k));
    const next = allChecked
      ? pages.filter((p) => !groupKeys.includes(p))
      : Array.from(new Set([...pages, ...groupKeys]));
    setPages(next);
    save(next);
  }

  function save(nextPages: string[]) {
    startTransition(async () => {
      try {
        await updateUserPermissions(detail.id, nextPages);
        router.refresh();
      } catch {
        toast.error("Failed to update permissions");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Permissions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left text-sm font-medium">Page</th>
                <th className="px-4 py-2 text-center text-sm font-medium w-24">Access</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([group, groupPages]) => {
                const groupKeys = groupPages.map((p) => p.key);
                const allChecked = groupKeys.every((k) => pages.includes(k));
                return (
                  <Fragment key={group}>
                    <tr className="border-b bg-muted/30">
                      <td className="px-4 py-2 text-sm font-semibold">{group}</td>
                      <td className="px-4 py-2 text-center">
                        <Switch
                          size="sm"
                          checked={allChecked}
                          disabled={isPending}
                          onCheckedChange={() => toggleGroup(group)}
                        />
                      </td>
                    </tr>
                    {groupPages.map((page) => (
                      <tr key={page.key} className="border-b">
                        <td className="px-4 py-2 pl-8 text-sm text-muted-foreground">{page.label}</td>
                        <td className="px-4 py-2 text-center">
                          <Switch
                            size="sm"
                            checked={pages.includes(page.key)}
                            disabled={isPending}
                            onCheckedChange={() => toggle(page.key)}
                          />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
