# syntax=docker/dockerfile:1

# The landing site is static output, so the build stage keeps Bun and the site's
# own dependencies out of the image that serves it.
FROM oven/bun:1.3.14 AS builder
WORKDIR /site

# Copied on their own so a copy change does not re-install dependencies.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Astro inlines both public origins at build time, so they are build arguments:
# changing either origin means rebuilding this image, not restarting it.
ARG PUBLIC_APP_URL=http://localhost:3000
ARG PUBLIC_SITE_URL=https://nuntia.app
ENV PUBLIC_APP_URL=$PUBLIC_APP_URL
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL
RUN bun run build

FROM nginx:1.29-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /site/dist /usr/share/nginx/html

EXPOSE 80
