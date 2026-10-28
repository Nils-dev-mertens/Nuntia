# syntax=docker/dockerfile:1

# Pinned past Bun 1.3.13 on purpose. On 1.3.10-1.3.13 loading
# `react-dom/server.bun.js` throws "Expected CommonJS module to have a function
# wrapper" once NODE_ENV is production (oven-sh/bun#36866, fixed in 1.3.14). The
# build is unaffected; the server crashes on boot, which is what the pin avoids.

# Build the client and server bundles. Dev dependencies (vite, typescript) are
# only needed here, which is why the runtime stage is separate.
FROM oven/bun:1.3.14 AS builder
WORKDIR /repo

# Copied on their own so a source change re-uses the installed dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.3.14-slim
WORKDIR /app

# NODE_ENV is load-bearing: `oauth.ts` and `session.ts` mark the session and
# OAuth-state cookies `Secure` only when it reads `production`. Everything else
# comes from the environment, which compose supplies from `.env` on the host.
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# `dist/` is the built app, `node_modules` its runtime dependencies, and
# `drizzle/` the migrations `initDatabase` applies on boot.
COPY --from=builder /repo/package.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/dist ./dist
COPY --from=builder /repo/drizzle ./drizzle

# The SQLite database, its WAL sidecars, the log and cached attachments all live
# under `data/`, which compose mounts as a volume.
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "dist/server/server.js"]
