import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep PDF parsing and native canvas dependencies out of the
  // Turbopack server bundle. They will be loaded by Node.js at runtime.
  serverExternalPackages: [
    "pdf-parse",
    "pdfjs-dist",
    "@napi-rs/canvas",
    "better-sqlite3",
  ],
};

export default nextConfig;
