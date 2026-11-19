import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Plus Jakarta Sans for everything you read (display headings get tight tracking in globals.css),
// JetBrains Mono for labels, timecodes and logs.
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], style: ["normal", "italic"], variable: "--font-grotesk", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: "Omnia — Every streaming service. One marquee.", template: "%s" },
  description:
    "Omnia folds Netflix, Prime Video, Disney+, HBO Max, Apple TV+ and every other streaming service into one liquid-glass theater, remembers exactly where you left off in each, and keeps your taste on your own PC.",
  icons: { icon: "/icon.png", apple: "/icon.png" },
  openGraph: {
    title: "Omnia — Every streaming service. One marquee.",
    description: "One hub for every OTT. Second-accurate cross-app history, local AI recommendations, a low-RAM native player and phone / TV handoff.",
    images: ["/screens/home.png"],
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#000000", viewportFit: "cover", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
