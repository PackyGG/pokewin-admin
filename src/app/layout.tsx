import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Chakra_Petch } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Chakra Petch — the "Grailed Dark" theme typeface. NOT a variable font,
// so explicit weights are required. Exposed as `--font-grailed`; the
// unlayered `.grailed { font-family: var(--font-grailed) … }` rule in
// globals.css switches the app to it only under the grailed theme (the
// light + dark themes keep Geist). `display: "swap"` avoids blocking
// first paint on the webfont.
const chakraPetch = Chakra_Petch({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-grailed",
  display: "swap",
});

// Absolute base for OG image URLs in link-preview embeds (Discord /
// Slack / iMessage / Twitter). Without this Next emits relative URLs
// and crawlers can't resolve them.
//
// Resolved per-deployment so the og:image URL always points at the
// SAME deployment that served the metadata — otherwise a branch
// preview would emit URLs that point at prod, and prod wouldn't have
// the file yet until the branch is merged. Priority:
//   1. NEXT_PUBLIC_SITE_URL  — explicit override (custom domains).
//   2. Production deployment → VERCEL_PROJECT_PRODUCTION_URL (clean alias).
//   3. Any other Vercel deployment → VERCEL_URL (this deployment).
//   4. Local fallback (npm run dev / non-Vercel build).
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? process.env.NEXT_PUBLIC_SITE_URL
  : process.env.VERCEL_ENV === "production" &&
      process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://pokewin-admin.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "PackyGG Admin",
    template: "%s · PackyGG Admin",
  },
  description: "Admin panel for PackyGG",
  icons: {
    icon: "/icon.png",
  },
  // Link-preview metadata. Title is static — every page shared
  // (login, withdrawals/[id], etc.) embeds the same branded text
  // card instead of "Sign In · PackyGG Admin". No og:image on
  // purpose — text-only embed.
  openGraph: {
    title: "PackyGG Admin dashboard",
    description: "PackyGG Admin dashboard",
    siteName: "PackyGG Admin",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PackyGG Admin dashboard",
    description: "PackyGG Admin dashboard",
  },
};

/**
 * Viewport config — `viewport-fit=cover` lets us draw under the iOS notch
 * / home indicator and reach the safe-area insets via env(). Without this,
 * iOS pads the page automatically and our sidebar drawer can't reach the
 * physical edges. `maximumScale=5` keeps a11y zoom available; we never
 * lock zoom because that's an a11y violation. `themeColor` shifts with
 * the theme so the iOS status-bar tint matches.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e15" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${chakraPetch.variable}`} suppressHydrationWarning>
      <body className="antialiased overflow-x-hidden">
        {/* Grailed is the default theme for a new visitor with no saved
            preference. `enableSystem` stays on so the preferences dropdown
            can still offer "System"; existing users keep their saved theme
            and can switch to dark/light via the toggle. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="grailed"
          enableSystem
          themes={["light", "dark", "grailed", "grailed-light"]}
        >
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <Toaster />
          <SpeedInsights />
        </ThemeProvider>
      </body>
    </html>
  );
}
