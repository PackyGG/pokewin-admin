"use client";

import { useEffect } from "react";

export default function TrelloLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    // Walk up from main and disable overflow on all scrollable ancestors
    const main = document.querySelector("main");
    if (!main) return;

    // Force override Tailwind classes
    main.style.setProperty("overflow", "hidden", "important");
    main.style.setProperty("padding", "0", "important");

    // Also block the parent wrapper div
    const wrapper = main.parentElement;
    if (wrapper) {
      wrapper.style.setProperty("overflow", "hidden", "important");
    }

    return () => {
      main.style.removeProperty("overflow");
      main.style.removeProperty("padding");
      if (wrapper) {
        wrapper.style.removeProperty("overflow");
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {children}
    </div>
  );
}
