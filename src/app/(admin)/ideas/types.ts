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
  /** Pixel position within the canvas coordinate space. */
  positionX: number;
  positionY: number;
  createdAt: string;
  createdBy: {
    id: string;
    username: string;
  } | null;
};

/**
 * Canvas-space dimensions. The scrollable inner surface is this big,
 * giving the team room to organize ideas across logical zones without
 * instantly hitting an edge. Cards themselves are clamped to stay
 * within this area on drag.
 */
export const CANVAS_WIDTH = 4000;
export const CANVAS_HEIGHT = 4000;
export const CARD_WIDTH = 260;
export const CARD_HEIGHT = 160;

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
