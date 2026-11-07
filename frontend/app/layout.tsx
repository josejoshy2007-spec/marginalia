import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import { Inter, Literata } from "next/font/google";
import { THEME_BOOTSTRAP } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./globals.css";

// Inter for everything; Literata only for long reading (font-reading).
const ui = Inter({ variable: "--font-ui", subsets: ["latin"] });
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
  themeColor: "#0e1016",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: THEME_BOOTSTRAP may add data-theme before React hydrates.
    <html lang="en" className={`${ui.variable} ${reading.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="h-full">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
