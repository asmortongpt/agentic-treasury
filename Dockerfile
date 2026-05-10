# Multi-stage Dockerfile for the agentic-treasury HTTP server.
# Uses Node 22+ which has native --experimental-strip-types so we
# don't need a separate TS build step.

FROM node:22-alpine AS base
WORKDIR /app

# --- deps stage ---
FROM base AS deps
COPY package.json tsconfig.json ./
# This package has zero runtime deps; install only what's needed for
# typecheck if anything were ever added.
RUN npm install --omit=dev --no-fund --no-audit --silent || true

# --- runtime stage ---
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY examples ./examples
COPY types ./types
COPY server.ts ./server.ts

# Drop root privileges. node:22-alpine ships with a `node` user (uid 1000)
# that owns nothing here, so we chown the app dir before switching.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck hits the /healthz endpoint our server exposes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:${PORT}/healthz || exit 1

# Native TS execution; no build step.
CMD ["node", "--experimental-strip-types", "--no-warnings", "server.ts"]
