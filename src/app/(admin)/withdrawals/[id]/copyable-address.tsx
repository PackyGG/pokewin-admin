"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyableAddress({ address }: { address: Record<string, string> }) {
  const [copied, setCopied] = useState(false);

  const lines = [
    `${address.first_name} ${address.last_name}`,
    address.address_line_1,
    address.address_line_2,
    `${address.city}, ${address.state_province} ${address.zip_code}`,
    address.country,
    address.phone_number ? `${address.phone_country_code} ${address.phone_number}` : null,
  ].filter(Boolean);

  function handleCopy() {
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="group relative w-full text-left text-sm space-y-1 rounded-md border border-transparent p-2 -m-2 hover:border-border hover:bg-accent/50 transition-colors cursor-copy"
    >
      {lines.map((line, i) => (
        <p key={i} className={i === lines.length - 1 && address.phone_number ? "text-muted-foreground" : ""}>
          {line}
        </p>
      ))}
      <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {copied ? (
          <Check className="size-3.5 text-emerald-400" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground" />
        )}
      </span>
    </button>
  );
}
