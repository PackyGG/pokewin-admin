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
  if (allowedPages && allowedPages.length > 0) return allowedPages[0];
  return "/dashboard";
}
