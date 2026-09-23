# syntax=docker/dockerfile:1.10
# Melogold server image: the normative Dockerfile of DESIGN §7.1 (m26).
# Build:  docker build --build-arg APP_VERSION=0.1.0 --build-arg GIT_SHA=$(git rev-parse HEAD) -t melogold-server .
# Check:  scripts/smoke.sh melogold-server
ARG NODE_MAJOR=24
# deps собирается на ЦЕЛЕВОЙ платформе (нативные раннеры amd64/arm64), glibc = debian13
FROM node:${NODE_MAJOR}-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts is safe (m25): better-sqlite3 13.0.3 has gypfile:false and ships prebuilds, argon2 finds its
# prebuild when loaded. The check below loads both native addons for real: importing better-sqlite3 alone does not
# load its addon, opening a database does.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts \
 && node --input-type=module -e "const { default: Database } = await import('better-sqlite3'); new Database(':memory:').prepare('SELECT 1').get(); await import('argon2')" \
 && mkdir -p /skel/data/.tmp

FROM gcr.io/distroless/nodejs${NODE_MAJOR}-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=8080 DATA_DIR=/data DATABASE_URL=sqlite:///data/melogold.db
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY openapi ./openapi
COPY --from=deps --chown=65532:65532 /skel/data /data
COPY --chmod=755 docker/melogold /usr/local/bin/melogold
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/melogold-app/melogoldServer" \
      org.opencontainers.image.licenses="AGPL-3.0-only" app.melogold.compose-schema="1"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/src/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/melogold"]
CMD ["serve"]
