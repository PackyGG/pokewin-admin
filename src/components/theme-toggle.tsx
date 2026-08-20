"use client";

import { useTheme } from "next-themes";
import { Sun, Moon, Sparkles, Sparkle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { AdminPreferences } from "@/lib/admin-preferences-types";
import { saveThemePreference } from "@/lib/theme-preference-client";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  async function pick(next: AdminPreferences["theme"]) {
    // Applying a visual preference must never depend on a network round-trip.
    // In particular, long-open tabs can outlive a production deployment.
    setTheme(next);
    try {
      await saveThemePreference(next);
    } catch {
      toast.warning("Theme applied on this device; account sync failed");
    }
  }

  return (
    <div className="flex items-center justify-center gap-1 group-data-[collapsible=icon]:flex-col">
      {/* Light ↔ dark quick toggle — behaviour unchanged */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => pick(theme === "dark" ? "light" : "dark")}
        className="size-8"
      >
        <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle light / dark</span>
      </Button>

      {/* Grailed Dark — same size, sits next to the light/dark toggle */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => pick("grailed")}
        className="size-8"
        title="Grailed Dark"
      >
        <Sparkles className="size-4" />
        <span className="sr-only">Grailed Dark theme</span>
      </Button>

      {/* Grailed Light — light sibling, distinct single-sparkle icon */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => pick("grailed-light")}
        className="size-8"
        title="Grailed Light"
      >
        <Sparkle className="size-4" />
        <span className="sr-only">Grailed Light theme</span>
      </Button>
    </div>
  );
}
