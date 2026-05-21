import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  // Absolute base for OG image URLs in link-preview embeds (Discord /
  // Slack / iMessage / Twitter). Without this Next emits relative URLs
  // and crawlers can't resolve them.
  metadataBase: new URL("https://pokewin-admin.vercel.app"),
  title: {
    default: "PackyGG Admin",
    template: "%s · PackyGG Admin",
  },
  description: "Admin panel for PackyGG",
  icons: {
    icon: "/icon.png",
  },
  // Link-preview metadata. Title is static — every page shared (login,
  // withdrawals/[id], etc.) shows the same branded card instead of
  // "Sign In · PackyGG Admin". The image is sourced from the
  // file-based metadata convention: `src/app/opengraph-image.jpg` is
  // auto-resolved by Next.js and injected as the og:image with the
  // correct width/height — no need to repeat the URL here.
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="antialiased overflow-x-hidden">
        {/* Dark mode stays the project default (CLAUDE.md). `enableSystem`
            is on so the admin preferences dropdown can offer a "System"
            option that follows the OS setting. */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <TooltipProvider>
            {children}
          </TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
