"use client";

import React from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils/format";
import type { UserDetail } from "./user-tabs-types";

export const ModerationSection = React.memo(function ModerationSection({
  user,
  mutes,
}: {
  user: UserDetail["user"];
  mutes: UserDetail["mutes"];
}) {
  return (
    <div className="space-y-6">
      {/* Ban/Lock Metadata */}
      {(user.isBanned || user.isLocked) && (
        <div className="space-y-3">
          {user.isBanned && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-red-400">Banned</p>
              {user.bannedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.bannedReason}
                </p>
              )}
              {user.bannedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.bannedAt)}
                </p>
              )}
              {user.bannedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.bannedBy}
                </p>
              )}
            </div>
          )}
          {user.isLocked && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-yellow-400">Locked</p>
              {user.lockedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.lockedReason}
                </p>
              )}
              {user.lockedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.lockedAt)}
                </p>
              )}
              {user.lockedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.lockedBy}
                </p>
              )}
              {user.lockedUntil && (
                <p className="text-xs text-muted-foreground">
                  Until: {formatDateTime(user.lockedUntil)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mute History */}
      {mutes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Mute History ({mutes.length})
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mutes.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs">
                    {formatDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">{m.reason ?? "-"}</TableCell>
                  <TableCell className="text-xs">
                    {m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        m.unmutedAt
                          ? "bg-green-500/15 text-green-600 dark:text-green-400"
                          : "bg-red-500/15 text-red-600 dark:text-red-400"
                      }
                    >
                      {m.unmutedAt ? "Unmuted" : "Active"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {mutes.length === 0 && !user.isBanned && !user.isLocked && (
        <p className="text-sm text-muted-foreground">No moderation history</p>
      )}
    </div>
  );
});
