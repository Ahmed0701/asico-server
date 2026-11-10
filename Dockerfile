ARG NODE_IMAGE=node:22.23-alpine

# Runtime dependencies. npm still installs the Prisma CLI here: it is an optional peer of @prisma/client (`devOptional` in the lockfile).
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
# `prisma generate` needs DATABASE_URL to exist but never connects.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
  && npm run build

# One-off job: applies migrations, then exits. Not part of the runtime image.
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/v1/health" || exit 1
CMD ["node", "dist/server.js"]
