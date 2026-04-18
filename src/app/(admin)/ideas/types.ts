/**
 * Pure types for the idea board. Separate from `actions.ts` (which has
 * `"use server"`) so client components can import type definitions
 * without pulling the server module across the boundary.
 */

export type IdeaStatus = "neutral" | "green" | "red";

export type Idea = {
  id: string;
  title: string;
  description: string | null;
  status: IdeaStatus;
  createdAt: string;
  createdBy: {
    id: string;
    username: string;
  } | null;
};

/** Cycle order: neutral → green → red → neutral. */
export const NEXT_STATUS: Record<IdeaStatus, IdeaStatus> = {
  neutral: "green",
  green: "red",
  red: "neutral",
};

export const STATUS_VALUES: IdeaStatus[] = ["neutral", "green", "red"];

export function isValidStatus(v: unknown): v is IdeaStatus {
  return typeof v === "string" && STATUS_VALUES.includes(v as IdeaStatus);
}
