import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import { Fraunces, Literata, Public_Sans } from "next/font/google";
import "./globals.css";

const ui = Public_Sans({ variable: "--font-ui", subsets: ["latin"] });
const display = Fraunces({ variable: "--font-display-face", subsets: ["latin"], style: ["normal", "italic"] });
const reading = Literata({ variable: "--font-reading-face", subsets: ["latin"], style: ["normal", "italic"] });

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Marginalia",
  description: "Study from your own sources, with every answer pinned to the passage it came from.",
  ...(process.env.NEXT_OUTPUT === "export" && { manifest: `${BASE}/manifest.webmanifest` }),
  icons: { icon: `${BASE}/icons/icon-192.png`, apple: `${BASE}/icons/apple-touch-icon.png` },
  appleWebApp: { capable: true, title: "Marginalia", statusBarStyle: "default" },
};


export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f0e6" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1a17" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable} ${reading.variable} h-full antialiased`}>
      <body className="h-full">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
