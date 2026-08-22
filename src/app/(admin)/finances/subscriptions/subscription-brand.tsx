import type { IconType } from "react-icons";
import { FaAws, FaSlack } from "react-icons/fa6";
import {
  Si1Password,
  SiAlgolia,
  SiAppwrite,
  SiAnthropic,
  SiAuth0,
  SiBetterstack,
  SiClickhouse,
  SiClerk,
  SiCloudflare,
  SiCloudinary,
  SiDatadog,
  SiDigitalocean,
  SiDiscord,
  SiDocker,
  SiDropbox,
  SiFigma,
  SiGithub,
  SiGoogle,
  SiGithubcopilot,
  SiGrafana,
  SiHetzner,
  SiHubspot,
  SiIntercom,
  SiJira,
  SiLinear,
  SiMailgun,
  SiMongodb,
  SiNeon,
  SiNotion,
  SiPostgresql,
  SiPosthog,
  SiRailway,
  SiResend,
  SiRedis,
  SiSentry,
  SiShopify,
  SiStripe,
  SiSupabase,
  SiUpstash,
  SiVercel,
  SiX,
  SiZoom,
  SiCursor,
  SiElasticsearch,
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

const ImageKitIcon: IconType = ({ className }) => (
  <svg className={className} viewBox="0 0 512 512" fill="none">
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M226.05 147.5c-6.78-7.34-10.16-15.81-10.16-27.1.56-10.73 4-19.2 11.29-27.11C235.08 86 243.55 82 254.85 82s19.15 4 26.53 11.29c7.91 7.91 11.86 16.38 11.86 27.11 0 11.29-4.52 19.76-11.86 27.1a38.79 38.79 0 0 1-27.66 10.73c-10.72 0-20.33-3.39-27.67-10.73Zm110.1 193.67c-38.39 104.46-184.07 132.69-157-2.82l31.62-153h66.63c-15.24 81.87-26.54 131.56-37.83 188.59-11.29 58.16 61 15.25 77.36-32.18l19.19-.57Z"
      clipRule="evenodd"
    />
  </svg>
);

const BRANDS: Brand[] = [
  {
    label: "Linear",
    pattern: /\blinear\b/i,
    icon: SiLinear,
    className: "bg-[#5e6ad2]/12 text-[#5e6ad2]",
  },
  {
    label: "Google Cloud",
    pattern: /\b(google cloud|gcp)\b/i,
    icon: SiGoogle,
    className: "bg-[#4285f4]/12 text-[#4285f4]",
  },
  {
    label: "Google",
    pattern: /\b(google|gmail|workspace)\b/i,
    icon: SiGoogle,
    className: "bg-[#4285f4]/12 text-[#4285f4]",
  },
  {
    label: "GitHub Copilot",
    pattern: /\bgithub copilot\b/i,
    icon: SiGithubcopilot,
    className: "bg-foreground/10 text-foreground",
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
    label: "Whop.com",
    pattern: /\bwhop(?:\.com)?\b/i,
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
    label: "TwitterAPI.io",
    pattern: /\btwitter\s?api(?:\.io)?\b/i,
    mark: "TAPI",
    className: "bg-[#1d9bf0]/14 text-[#1d9bf0]",
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
    icon: ImageKitIcon,
    className: "bg-[#0450d5] text-white",
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
  {
    label: "OpenAI Codex",
    pattern: /\b(?:openai\s+)?codex\b/i,
    mark: "CX",
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "OpenAI / ChatGPT",
    pattern: /\b(openai|chatgpt)\b/i,
    mark: "AI",
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "Claude / Anthropic",
    pattern: /\b(claude|anthropic)\b/i,
    icon: SiAnthropic,
    className: "bg-[#d97757]/12 text-[#c66545] dark:text-[#e28b6d]",
  },
  {
    label: "Cursor",
    pattern: /\bcursor\b/i,
    icon: SiCursor,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "1Password",
    pattern: /\b(1password|onepassword)\b/i,
    icon: Si1Password,
    className: "bg-[#3b66bc]/12 text-[#3b66bc] dark:text-[#6f98ec]",
  },
  {
    label: "PostHog",
    pattern: /\bposthog\b/i,
    icon: SiPosthog,
    className: "bg-[#f9bd2b]/14 text-[#d99000] dark:text-[#f9bd2b]",
  },
  {
    label: "Slack",
    pattern: /\bslack\b/i,
    icon: FaSlack,
    className: "bg-[#4a154b]/12 text-[#611f69] dark:text-[#e5a5e6]",
  },
  {
    label: "Datadog",
    pattern: /\bdatadog\b/i,
    icon: SiDatadog,
    className: "bg-[#632ca6]/12 text-[#632ca6] dark:text-[#a879dd]",
  },
  {
    label: "Redis",
    pattern: /\bredis\b/i,
    icon: SiRedis,
    className: "bg-[#ff4438]/12 text-[#e43a30] dark:text-[#ff5f55]",
  },
  {
    label: "ClickHouse",
    pattern: /\bclickhouse\b/i,
    icon: SiClickhouse,
    className: "bg-[#ffcc01]/14 text-[#b99000] dark:text-[#ffcc01]",
  },
  {
    label: "MongoDB",
    pattern: /\bmongo(?:db)?\b/i,
    icon: SiMongodb,
    className: "bg-[#47a248]/12 text-[#47a248]",
  },
  {
    label: "Supabase",
    pattern: /\bsupabase\b/i,
    icon: SiSupabase,
    className: "bg-[#3ecf8e]/12 text-[#2da771] dark:text-[#3ecf8e]",
  },
  {
    label: "Appwrite",
    pattern: /\bappwrite\b/i,
    icon: SiAppwrite,
    className: "bg-[#fd366e]/12 text-[#fd366e]",
  },
  {
    label: "PostgreSQL",
    pattern: /\b(postgres|postgresql)\b/i,
    icon: SiPostgresql,
    className: "bg-[#4169e1]/12 text-[#4169e1]",
  },
  {
    label: "Cloudinary",
    pattern: /\bcloudinary\b/i,
    icon: SiCloudinary,
    className: "bg-[#3448c5]/12 text-[#3448c5] dark:text-[#7584ed]",
  },
  {
    label: "Auth0",
    pattern: /\bauth0\b/i,
    icon: SiAuth0,
    className: "bg-[#eb5424]/12 text-[#eb5424]",
  },
  {
    label: "Clerk",
    pattern: /\bclerk\b/i,
    icon: SiClerk,
    className: "bg-[#6c47ff]/12 text-[#6c47ff]",
  },
  {
    label: "Neon",
    pattern: /\bneon\b/i,
    icon: SiNeon,
    className: "bg-[#00e599]/12 text-[#00a875] dark:text-[#00e599]",
  },
  {
    label: "Upstash",
    pattern: /\bupstash\b/i,
    icon: SiUpstash,
    className: "bg-[#00e9a3]/12 text-[#00a878] dark:text-[#00e9a3]",
  },
  {
    label: "Resend",
    pattern: /\bresend\b/i,
    icon: SiResend,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "Mailgun",
    pattern: /\bmailgun\b/i,
    icon: SiMailgun,
    className: "bg-[#f06b66]/12 text-[#e3514b] dark:text-[#f48782]",
  },
  {
    label: "HubSpot",
    pattern: /\bhubspot\b/i,
    icon: SiHubspot,
    className: "bg-[#ff7a59]/12 text-[#ff6842]",
  },
  {
    label: "Jira",
    pattern: /\b(jira|atlassian)\b/i,
    icon: SiJira,
    className: "bg-[#0052cc]/12 text-[#1868db]",
  },
  {
    label: "Docker",
    pattern: /\bdocker\b/i,
    icon: SiDocker,
    className: "bg-[#2496ed]/12 text-[#2496ed]",
  },
  {
    label: "Grafana Cloud",
    pattern: /\bgrafana(?: cloud)?\b/i,
    icon: SiGrafana,
    className: "bg-[#f46800]/12 text-[#f46800]",
  },
  {
    label: "Better Stack",
    pattern: /\bbetter\s?stack\b/i,
    icon: SiBetterstack,
    className: "bg-foreground/10 text-foreground",
  },
  {
    label: "Elastic",
    pattern: /\b(elastic|elasticsearch)\b/i,
    icon: SiElasticsearch,
    className: "bg-[#00bfb3]/12 text-[#009c93] dark:text-[#20d4ca]",
  },
  {
    label: "Algolia",
    pattern: /\balgolia\b/i,
    icon: SiAlgolia,
    className: "bg-[#003dff]/12 text-[#3159d9] dark:text-[#6c88ff]",
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
