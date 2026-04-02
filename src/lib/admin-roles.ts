export type AdminRole = "admin" | "support" | "marketing" | "creator";

export function getDefaultRoute(role: string, allowedPages?: string[]): string {
  if (role === "admin") return "/dashboard";
  if (role === "creator") return "/my-profile";
  if (allowedPages && allowedPages.length > 0) return allowedPages[0];
  return "/chat";
}
