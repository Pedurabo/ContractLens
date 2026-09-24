import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Externalizing pdfjs-dist and better-sqlite3 is necessary for server-side
  // Node.js environments to correctly handle dynamic imports (like workers)
  // and native modules, especially when using Turbopack.
  serverExternalPackages: ["pdfjs-dist", "better-sqlite3"],
};

export default nextConfig;
