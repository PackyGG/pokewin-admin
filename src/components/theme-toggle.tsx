"use client";

import { useTheme } from "next-themes";
import { Sun, Moon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center justify-center gap-1 group-data-[collapsible=icon]:flex-col">
      {/* Light ↔ dark quick toggle — behaviour unchanged */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="size-8"
      >
        <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        <span className="sr-only">Toggle light / dark</span>
      </Button>

      {/* Grailed Dark — new, same size, sits next to the light/dark toggle */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setTheme("grailed")}
        className="size-8"
        title="Grailed Dark"
      >
        <Sparkles className="size-4" />
        <span className="sr-only">Grailed Dark theme</span>
      </Button>
    </div>
  );
}
