"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { API_ENDPOINTS, endpointAccess } from "@/lib/api-auth/endpoints";

/**
 * Read-only catalogue of the `/api/v1/*` surface — what exists, what it does
 * and which scope unlocks it. Sits under the key table so the scope names an
 * operator just granted line up with the endpoints they unlock.
 *
 * Source of truth for the list is `src/lib/api-auth/endpoints.ts`.
 */

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  POST: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PATCH: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  PUT: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  DELETE: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

export function ApiEndpointsSection() {
  if (API_ENDPOINTS.length === 0) {
    return (
      <div className="rounded-xl border">
        <EmptyState
          icon={Plug}
          title="No endpoints yet"
          description="Routes added under src/app/api/v1 appear here once registered."
          compact
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Method</TableHead>
            <TableHead>Endpoint</TableHead>
            <TableHead>Required scope</TableHead>
            <TableHead>Description</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {API_ENDPOINTS.map((endpoint) => {
            const access = endpointAccess(endpoint);
            return (
              <TableRow key={`${endpoint.method} ${endpoint.path}`}>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn(
                      "font-mono text-[10px]",
                      METHOD_STYLES[endpoint.method] ?? "text-muted-foreground",
                    )}
                  >
                    {endpoint.method}
                  </Badge>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs">{endpoint.path}</code>
                  {access === "admin-write" && (
                    <Badge
                      variant="outline"
                      className="ml-2 bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
                    >
                      writes admin DB
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {endpoint.scopes.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      any valid key
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {endpoint.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="text-[10px]">
                          {scope}
                        </Badge>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {endpoint.summary}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
