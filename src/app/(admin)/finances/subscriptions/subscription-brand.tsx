import type { IconType } from "react-icons";
import { FaAws } from "react-icons/fa6";
import {
  SiCloudflare,
  SiDigitalocean,
  SiDiscord,
  SiDropbox,
  SiFigma,
  SiGithub,
  SiGoogle,
  SiHetzner,
  SiIntercom,
  SiLinear,
  SiNotion,
  SiRailway,
  SiSentry,
  SiShopify,
  SiStripe,
  SiVercel,
  SiX,
  SiZoom,
} from "react-icons/si";
import { Building2 } from "lucide-react";

import { cn } from "@/lib/utils";

type Brand = {
  label: string;
  pattern: RegExp;
  icon?: IconType;
  mark?: string;
  className: string;
};

const BRANDS: Brand[] = [
  {
    label: "Linear",
    pattern: /\blinear\b/i,
    icon: SiLinear,
    className: "bg-[#5e6ad2]/12 text-[#5e6ad2]",
  },
  {
    label: "Google",
    pattern: /\b(google|gmail|workspace)\b/i,
    icon: SiGoogle,
    className: "bg-[#4285f4]/12 text-[#4285f4]",
  },
  {
    label: "GitHub",
    pattern: /\bgithub\b/i,
    icon: SiGithub,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "AWS",
    pattern: /\b(aws|amazon web services)\b/i,
    icon: FaAws,
    className: "bg-[#ff9900]/14 text-[#e88b00] dark:text-[#ff9900]",
  },
  {
    label: "Vercel",
    pattern: /\bvercel\b/i,
    icon: SiVercel,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "Whop",
    pattern: /\bwhop\b/i,
    mark: "W",
    className: "bg-[#ff6243]/14 text-[#ff6243]",
  },
  {
    label: "CoinGecko",
    pattern: /\bcoin\s?gecko\b/i,
    mark: "CG",
    className: "bg-[#8dc63f]/16 text-[#659d1f] dark:text-[#9bd84b]",
  },
  {
    label: "Hetzner",
    pattern: /\bhetz(?:b)?ner\b/i,
    icon: SiHetzner,
    className: "bg-[#d50c2d]/12 text-[#d50c2d]",
  },
  {
    label: "X / Twitter",
    pattern: /^(x|twitter)\b|\b(x premium|x pro)\b/i,
    icon: SiX,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "ImageKit",
    pattern: /\b(image\s?kit|imgaekit)\b/i,
    mark: "IK",
    className: "bg-[#7b61ff]/14 text-[#7255f3] dark:text-[#927fff]",
  },
  {
    label: "Adobe Photoshop",
    pattern: /\b(photoshop|adobe(?: ps| creative cloud)?)\b/i,
    mark: "Ps",
    className: "bg-[#001e36] text-[#31a8ff]",
  },
  {
    label: "Intercom",
    pattern: /\bintercom\b/i,
    icon: SiIntercom,
    className: "bg-[#286efa]/12 text-[#286efa]",
  },
  {
    label: "Sentry",
    pattern: /\bsentry\b/i,
    icon: SiSentry,
    className: "bg-[#362d59]/12 text-[#6c5fc7] dark:text-[#a69ae8]",
  },
  {
    label: "Stripe",
    pattern: /\bstripe\b/i,
    icon: SiStripe,
    className: "bg-[#635bff]/12 text-[#635bff]",
  },
  {
    label: "Cloudflare",
    pattern: /\bcloudflare\b/i,
    icon: SiCloudflare,
    className: "bg-[#f38020]/12 text-[#f38020]",
  },
  {
    label: "Railway",
    pattern: /\brailway\b/i,
    icon: SiRailway,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "DigitalOcean",
    pattern: /\bdigital\s?ocean\b/i,
    icon: SiDigitalocean,
    className: "bg-[#0080ff]/12 text-[#0080ff]",
  },
  {
    label: "Discord",
    pattern: /\bdiscord\b/i,
    icon: SiDiscord,
    className: "bg-[#5865f2]/12 text-[#5865f2]",
  },
  {
    label: "Figma",
    pattern: /\bfigma\b/i,
    icon: SiFigma,
    className: "bg-[#a259ff]/12 text-[#a259ff]",
  },
  {
    label: "Notion",
    pattern: /\bnotion\b/i,
    icon: SiNotion,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "Shopify",
    pattern: /\bshopify\b/i,
    icon: SiShopify,
    className: "bg-[#7ab55c]/14 text-[#679c4d] dark:text-[#95c87a]",
  },
  {
    label: "Dropbox",
    pattern: /\bdropbox\b/i,
    icon: SiDropbox,
    className: "bg-[#0061ff]/12 text-[#0061ff]",
  },
  {
    label: "Zoom",
    pattern: /\bzoom\b/i,
    icon: SiZoom,
    className: "bg-[#0b5cff]/12 text-[#0b5cff]",
  },
];

export const SUBSCRIPTION_SERVICES = BRANDS.map((brand) => brand.label);

export function SubscriptionBrand({
  name,
  size = "default",
}: {
  name: string;
  size?: "default" | "sm";
}) {
  const brand = BRANDS.find((candidate) => candidate.pattern.test(name));
  const Icon = brand?.icon;
  const compact = size === "sm";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center border border-current/10",
        compact ? "size-6 rounded-md" : "size-9 rounded-xl",
        brand?.className ?? "bg-muted text-muted-foreground",
      )}
      title={brand?.label ?? "Subscription"}
      aria-hidden="true"
    >
      {Icon ? (
        <Icon className={compact ? "size-3.5" : "size-[18px]"} />
      ) : brand?.mark ? (
        <span
          className={cn(
            "font-bold tracking-tight",
            compact ? "text-[9px]" : "text-[11px]",
          )}
        >
          {brand.mark}
        </span>
      ) : (
        <Building2 className={compact ? "size-3" : "size-4"} />
      )}
    </div>
  );
}
