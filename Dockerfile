# syntax=docker/dockerfile:1
# ------------------------------------------------------------------
# Booking bot — multi-stage image.
#
#   build:   typecheck-free tsc build + pruned production node_modules
#   runtime: slim Debian + Chromium (with system deps) + dist/
#
# The image ships ONLY the bot. The demo portal, tests and docs are
# development artifacts — they stay on the host.
# ------------------------------------------------------------------

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=UTC

WORKDIR /app

# Chromium's shared-library deps + the certs we need to reach the portal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config

# Only Chromium is installed; nothing else is downloaded at build time.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R 10001:0 /ms-playwright

# Unprivileged runtime user; storage holds sessions/artifacts/logs.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin bot \
 && mkdir -p /app/storage && chown -R bot:0 /app/storage /app/config

USER bot
VOLUME ["/app/storage"]

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
