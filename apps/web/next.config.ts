import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@signal-audit/domain", "@signal-audit/contracts"]
};

export default nextConfig;
