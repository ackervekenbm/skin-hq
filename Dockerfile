# Build stage
FROM node:22-alpine AS build
WORKDIR /app
ARG COMMIT_SHA
ARG BUILD_TIME
ARG GITHUB_REPOSITORY
ENV COMMIT_SHA=$COMMIT_SHA BUILD_TIME=$BUILD_TIME GITHUB_REPOSITORY=$GITHUB_REPOSITORY
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime stage — the Express server serves the compiled client and the API.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist-server/index.js"]