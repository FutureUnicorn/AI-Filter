import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  transpilePackages: ["@signal-audit/domain"]
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_WEB_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  sourcemaps: {
    // Uploading is intentionally opt-in. Runtime monitoring does not require
    // the Sentry CLI install script or a build-time secret.
    disable: process.env.SENTRY_AUTH_TOKEN === undefined
  }
});
