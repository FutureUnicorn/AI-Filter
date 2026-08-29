import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@signal-audit/domain"]
};

export default nextConfig;
