# Production image of the API. Built by deploy/docker-compose.prod.yml (service "app").
#   Run:      node dist/server.js                       (the default command)
#   Migrate:  npx prisma migrate deploy                 (deploy/scripts/first-run.sh, update.sh)
#   Seed:     node dist/cli/seed.js                     (permissions + the first admin; no tsx at runtime)
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# openssl for Prisma, tzdata for time zone names, ca-certificates for SMTP over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl tzdata ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Runtime dependencies only. npm still installs the Prisma CLI: it is an optional peer of @prisma/client
# ("devOptional" in the lockfile), and the image needs it for "prisma migrate deploy".
FROM base AS prod-deps
COPY package.json package-lock.json ./
# Install scripts stay off, except Prisma's: it downloads the schema engine "prisma migrate deploy" needs. Done here, as
# root, because the runtime user cannot write into node_modules.
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild @prisma/engines prisma \
  && npm cache clean --force

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
# "prisma generate" needs DATABASE_URL to exist but never connects. The build also copies src/assets into dist.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
  && npm run build

FROM base AS runtime
ENV NODE_ENV=production \
  PORT=8080 \
  UPLOAD_DIR=/app/uploads
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The schema, the migrations and the Prisma config, for "prisma migrate deploy" inside this image.
COPY package.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
# The villa documents and delivery notes folder: a named volume is mounted here, owned by the non-root user.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
