# Build stage
# Pinned by digest so builds are reproducible; Dependabot bumps it (docker ecosystem).
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app
ARG COMMIT_SHA
ARG BUILD_TIME
ARG GITHUB_REPOSITORY
ENV COMMIT_SHA=$COMMIT_SHA BUILD_TIME=$BUILD_TIME GITHUB_REPOSITORY=$GITHUB_REPOSITORY
COPY package.json package-lock.json .npmrc ./
# `.npmrc` turns dependency lifecycle scripts off, so npm's implicit
# `node-gyp rebuild` for better-sqlite3 never runs: no toolchain needed.
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime stage — the Express server serves the compiled client and the API.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Script-free install (`.npmrc`): better-sqlite3 ships musl prebuilds, so the
# runtime binary comes straight out of the package and no python3/build-base
# toolchain has to be installed in this stage.
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
# The app runs as the image's unprivileged `node` user (uid 1000). The
# entrypoint starts as root only to hand the data folder to `node` (files a
# root-run image or restore left there), then drops to `node` with su-exec, a
# tiny static helper, not a build toolchain.
RUN apk add --no-cache su-exec && mkdir -p /app/data && chown node:node /app/data
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/skin-hq-entrypoint
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["skin-hq-entrypoint"]
CMD ["node", "dist-server/index.js"]
