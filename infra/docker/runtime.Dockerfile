FROM node:24.16.0-bookworm-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY packages/security/package.json packages/security/package.json

RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
RUN pnpm build

FROM node:24.16.0-bookworm-slim AS runtime-base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production
WORKDIR /workspace
RUN corepack enable
COPY --from=build /workspace /workspace

FROM runtime-base AS web
EXPOSE 3000
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "-H", "0.0.0.0", "-p", "3000"]

FROM runtime-base AS worker
EXPOSE 3001
CMD ["node", "apps/worker/dist/index.js"]
