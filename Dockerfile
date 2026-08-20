# Dockerfile: one image, two entrypoints — the NestJS API (default CMD) and the LiveKit voice
# worker (override the command). Node 22 is a floor, not a preference: @supabase/supabase-js
# needs a native WebSocket and dies at boot on 20. pnpm is pinned so the workspace settings
# that exclude @livekit/local-inference are read instead of silently recomputed.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# node:22-slim ships no /etc/ssl/certs. Node bundles its own roots, so the API is fine, but the
# Rust engine inside @livekit/rtc-node reads the system store and rejects every job without it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist

# Resolved from process.cwd() at runtime, never from dist/: nest-cli copies no non-.ts asset.
# Dropping any of these leaves a container that starts healthy and fails on the first quote,
# the first policy PDF or the first affiliate lookup.
COPY src/modules/quoting/catalog ./src/modules/quoting/catalog
COPY src/images ./src/images
COPY src/assets ./src/assets
COPY Usos_Productos_Afiliados_SIMULADO.csv ./

EXPOSE 8080
CMD ["node", "dist/main"]
