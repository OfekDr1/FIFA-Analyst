import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  applicationName: "World Cup HUD",
  title: {
    default: "World Cup HUD",
    template: "%s · World Cup HUD",
  },
  description: "Live FIFA World Cup statistics, analytics & power rankings.",
  // → <link rel="manifest" href="/manifest.json">
  manifest: "/manifest.json",
  // → apple-mobile-web-app-capable, -status-bar-style, -title + apple touch icon
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "World Cup HUD",
  },
  // → <link rel="icon"> and <link rel="apple-touch-icon">
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // → <meta name="theme-color" content="#000000"> (tints the status bar)
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  // Lets the app draw under notches/safe areas in standalone mode
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} antialiased`}>{children}</body>
    </html>
  );
}
