import type { NextConfig } from "next";
import { applicationSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...applicationSecurityHeaders],
      },
    ];
  },
  experimental: {
    serverActions: {
      // Document uploads go through Server Actions. Files are limited to 4 MB
      // (MAX_DOCUMENT_FILE_SIZE_BYTES); the extra space covers multipart overhead and
      // form fields and stays below Vercel's ~4.5 MB request body limit.
      bodySizeLimit: 4_400_000,
    },
  },
};

export default nextConfig;
