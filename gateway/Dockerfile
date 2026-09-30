# ---- build ----
FROM node:22-bookworm-slim AS build
# toolchain so better-sqlite3 can compile if no prebuilt binary is downloadable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production GATEWAY_LISTEN_HOST=0.0.0.0 CONFIG_DIR=/config USAGE_DB_PATH=/data/usage.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
# nice: web (PHP/MySQL) always wins the CPU on the shared server.
CMD ["nice", "-n", "10", "node", "--max-old-space-size=160", "dist/server.js"]
