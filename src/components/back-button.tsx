"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

export function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
    >
      <ArrowLeft className="size-4" />
    </button>
  );
}
