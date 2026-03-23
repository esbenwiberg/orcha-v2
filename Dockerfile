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

# Download Chromium for Playwright (baked into image for deterministic builds)
RUN npx playwright install chromium

# Compile landlock-exec as a static binary so it has no runtime deps
RUN gcc -O2 -static -o /build/landlock-exec sandbox/landlock-exec.c

# Stage 2: runtime — lean image with compiled output
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    git fuse3 ca-certificates curl gnupg libicu72 \
    python3 make g++ \
    # Chromium runtime deps for Playwright (from `npx playwright install-deps chromium`)
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
    # Fonts for Playwright screenshots (without these, pages render blank boxes)
    fonts-liberation fonts-noto-color-emoji libfontconfig1 libfreetype6 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
       | gpg --dearmor -o /usr/share/keyrings/microsoft-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft-archive-keyring.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main" \
       > /etc/apt/sources.list.d/azure-cli.list \
    # Docker CE CLI + Compose plugin — for docker-mode validation (DinD via socket mount)
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       gh azure-cli docker-ce-cli docker-compose-plugin gosu \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN groupadd -r orcha && useradd -r -g orcha -d /app orcha

# Let orcha user update global npm packages (claude-code) at boot
RUN chown -R orcha:orcha /usr/local/lib/node_modules /usr/local/bin

WORKDIR /app

COPY --from=builder /build/landlock-exec /usr/local/bin/landlock-exec
COPY scripts/entrypoint.sh /app/entrypoint.sh
COPY scripts/seed-local.mjs /app/scripts/seed-local.mjs
COPY scripts/local-entrypoint.sh /app/scripts/local-entrypoint.sh
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
# Playwright Chromium binary from builder
COPY --from=builder /root/.cache/ms-playwright /app/.cache/ms-playwright
# Static assets — express.static('src/web/public') is CWD-relative
COPY --from=builder /build/src/web/public ./src/web/public
# ETA views — resolved via path.join(__dirname, 'views') from dist/web/
COPY --from=builder /build/src/web/views ./dist/web/views
# DB migrations — resolved via path.resolve(__dirname, '../db/migrations') from dist/web/
COPY --from=builder /build/src/db/migrations ./dist/db/migrations

RUN mkdir -p /data /data/sdks && chown -R orcha:orcha /data
# Pre-create the orcha user's ~/.claude so the landlock RW rule for it is applied on session start
# Also create ~/.azure so `az login` works (HOME=/app which is otherwise read-only)
# Pre-create /tmp/.dotnet/shm so .NET named mutexes work under landlock
# (landlock blocks the mkdir syscall dotnet uses to create this dir at runtime)
RUN mkdir -p /app/.claude /app/.azure /app/.npm /app/.cache /tmp/.dotnet/shm \
    && chown -R orcha:orcha /app/.claude /app/.azure /app/.npm /app/.cache /tmp/.dotnet/shm

# Global git config for the orcha user — Azure File Share (SMB) reports all
# files as 755 and presents them with a different UID, which confuses git.
RUN printf '[core]\n\tfileMode = false\n[safe]\n\tdirectory = *\n[credential]\n\thelper = store\n' > /app/.gitconfig \
    && chown orcha:orcha /app/.gitconfig

VOLUME ["/data"]

EXPOSE 3000

ARG COMMIT_SHA=""

ENV NODE_ENV=production \
    ORCHA_DATA_DIR=/data \
    SANDBOX_MODE=landlock \
    PLAYWRIGHT_BROWSERS_PATH=/app/.cache/ms-playwright \
    DOTNET_CLI_HOME=/tmp/dotnet-cli \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_NOLOGO=true \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    COMMIT_SHA=${COMMIT_SHA}

# No USER directive — entrypoint runs as root to configure docker socket
# group membership, then drops to orcha via gosu.
CMD ["bash", "/app/entrypoint.sh"]
