import type { NextConfig } from "next";

// NEXT_OUTPUT=export builds the static on-device app (GitHub Pages PWA and the Android APK);
// NEXT_PUBLIC_BASE_PATH is the sub-path it is served from (e.g. "/marginalia" on GitHub Pages).
const exporting = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  ...(exporting && {
    output: "export",
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
    trailingSlash: true,
    images: { unoptimized: true },
  }),
  // Server-rendering features; not available (or needed) in the static on-device build.
  ...(!exporting && { cacheComponents: true, partialPrefetching: true }),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
