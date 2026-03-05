# Stage 1: builder — compile native addons, TypeScript, and landlock-exec
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ gcc git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package.json package-lock.json ./
COPY scripts/vendor-assets.js scripts/vendor-assets.js
RUN npm ci

COPY . .
RUN npm run build

# Compile landlock-exec as a static binary so it has no runtime deps
RUN gcc -O2 -static -o /build/landlock-exec sandbox/landlock-exec.c

# Stage 2: runtime — lean image with compiled output
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    git fuse3 ca-certificates curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN groupadd -r orcha && useradd -r -g orcha -d /app orcha

# Let orcha user update global npm packages (claude-code) at boot
RUN chown -R orcha:orcha /usr/local/lib/node_modules /usr/local/bin

WORKDIR /app

COPY --from=builder /build/landlock-exec /usr/local/bin/landlock-exec
COPY scripts/entrypoint.sh /app/entrypoint.sh
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
# Pre-create the orcha user's ~/.claude so the landlock RW rule for it is applied on session start
RUN mkdir -p /app/.claude && chown -R orcha:orcha /app/.claude

# Global git config for the orcha user — Azure File Share (SMB) reports all
# files as 755 and presents them with a different UID, which confuses git.
RUN printf '[core]\n\tfileMode = false\n[safe]\n\tdirectory = *\n[credential]\n\thelper = store\n' > /app/.gitconfig \
    && chown orcha:orcha /app/.gitconfig

VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    ORCHA_DATA_DIR=/data \
    SANDBOX_MODE=landlock

USER orcha

CMD ["bash", "/app/entrypoint.sh"]
