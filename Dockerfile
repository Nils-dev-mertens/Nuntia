# syntax=docker/dockerfile:1

# Pinned past Bun 1.3.13 on purpose. On 1.3.10-1.3.13 loading
# `react-dom/server.bun.js` throws "Expected CommonJS module to have a function
# wrapper" once NODE_ENV is production (oven-sh/bun#36866, fixed in 1.3.14). The
# build is unaffected; the server crashes on boot, which is what the pin avoids.
#
# 1.4.4 rather than 1.3.14: on 1.3.14 a CommonJS `require()` of an ESM-only
# package (`sanitize-html` -> `htmlparser2`) fails nondeterministically with
# "require() async module ... is unsupported" when the module graph is loaded
# asynchronously, which made `bun test` fail on some runs and pass on others.

# Build the client and server bundles. Dev dependencies (vite, typescript) are
# only needed here, which is why the runtime stage is separate.
FROM oven/bun:1.4.4 AS builder
WORKDIR /repo

# Copied on their own so a source change re-uses the installed dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# The image ships no source, and one maintenance script has to be runnable from
# inside the container: giving a locked-out account a password. Bundled beside
# the server so it resolves the same runtime dependencies:
#   docker compose exec app bun dist/set-password.js <email> <password>
RUN bun build scripts/set-password.ts --target bun --packages external \
    --outfile dist/set-password.js

# The web app. Named because `mcp` is the last stage in this file: a Compose
# build for the app must select this target explicitly or it gets the MCP image.
FROM oven/bun:1.4.4-slim AS app
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

# The MCP service, built as its own stage and run as its own container.
# It runs the TypeScript directly rather than a bundle: the app image is
# deliberately source-free, and a second bundle would have to duplicate the
# whole module graph for one small entry point. It mounts the same data volume,
# so it sees the same database; see docs/mcp.md for the SQLite caveat.
FROM oven/bun:1.4.4-slim AS mcp
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3333

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY drizzle ./drizzle

RUN mkdir -p /app/data

EXPOSE 3333

CMD ["bun", "src/mcp/server.ts"]
