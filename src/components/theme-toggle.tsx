"use client";

import { useTheme } from "next-themes";
import { Sun, Moon, Sparkles, Sparkle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { updatePreferences } from "@/app/(admin)/profile/preferences-actions";
import type { AdminPreferences } from "@/lib/admin-preferences-types";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  async function pick(next: AdminPreferences["theme"]) {
    const previous = theme;
    setTheme(next);
    try {
      await updatePreferences({ theme: next });
    } catch (err) {
      if (previous) setTheme(previous);
      toast.error(err instanceof Error ? err.message : "Could not save theme");
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
