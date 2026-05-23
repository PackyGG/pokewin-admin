export type AdminRole =
  | "admin"
  | "support"
  | "marketing"
  | "creator"
  | "pack_creator";

export function getDefaultRoute(role: string, allowedPages?: string[]): string {
  if (role === "admin") return "/dashboard";
  if (role === "creator") return "/my-profile";
  // pack_creator's whole job is creating packs — land them straight on the
  // packs page so they don't have to navigate.
  if (role === "pack_creator") return "/packs";
  // Prefer the dashboard as the landing page whenever this user can
  // actually reach it. Without this, the default was whatever happened to
  // be FIRST in allowed_pages — so a user with dashboard access but
  // "/users" first in their list got bounced to /users on every reload.
  if (allowedPages?.includes("/dashboard")) return "/dashboard";
  if (allowedPages && allowedPages.length > 0) return allowedPages[0];
  return "/dashboard";
}
