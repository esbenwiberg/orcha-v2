# Stage 1: builder — compile native addons and TypeScript
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package.json package-lock.json ./
COPY scripts/vendor-assets.js scripts/vendor-assets.js
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: runtime — lean image with compiled output
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    git fuse3 ca-certificates bubblewrap \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r orcha && useradd -r -g orcha -d /app orcha

WORKDIR /app

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
# Static assets — express.static('src/web/public') is CWD-relative
COPY --from=builder /build/src/web/public ./src/web/public
# ETA views — resolved via path.join(__dirname, 'views') from dist/web/
COPY --from=builder /build/src/web/views ./dist/web/views
# DB migrations — resolved via path.resolve(__dirname, '../db/migrations') from dist/web/
COPY --from=builder /build/src/db/migrations ./dist/db/migrations

RUN mkdir -p /data && chown orcha:orcha /data

VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    ORCHA_DATA_DIR=/data \
    SANDBOX_MODE=bwrap

USER orcha

CMD node dist/web/start-server.js 2>&1
