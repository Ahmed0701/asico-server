# asico-server

Modular monolith API. Work only in this repository.

## Layout

- `src/core` — config (env, logger), database (Prisma), errors, i18n, middleware, audit, storage
- `src/shared` — query helpers, constants, types, utils
- `src/modules/<name>` — controller, dto, mapper, repository, routes, service, validators
- `src/routes` — mounts module routers under `/api/v1`
- `src/assets` — static files copied to `dist` on build
- `src/generated` — Prisma client (gitignored, created by `npx prisma generate`)
- `prisma` — schema, migrations (`init` generated; `extras` hand-written SQL), seed
- `scripts` — build helpers
- `tests` — setup, `core`, `shared`, `prisma`, and `modules/<name>` tests

## Commands

```bash
npm run dev
npm run lint
npm run format
npm run typecheck
npm test
npm run build
npx prisma generate
npx prisma migrate dev
```

Copy `.env.example` to `.env` before running. PostgreSQL URL is `DATABASE_URL`. `NODE_ENV` is required.

## Conventions

- Pagination: query params `page` (default 1) and `limit` (default 20, max 1000). Out-of-range or non-numeric values return 400; they are never clamped. Use `paginationQuerySchema` from `src/shared/query/pagination.ts` with `validate(..., "query")`.
- Database: `AuditLog` is append-only (enforced by a trigger). ADMIN permissions are implied by the role; only EMPLOYEE users get `UserPermission` rows. Write audit entries with `audit.record(tx, ...)` inside the same transaction as the change.

## Git workflow

- The owner works locally on main, reviews diffs, commits and pushes manually.
- Never create branches, never open PRs, never commit or push unless explicitly asked.
- At the end of each task, list the files changed so the owner can review the diff.
