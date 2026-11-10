# asico-server

Backend API for Asico: the management of a villa-building programme. It tracks villas and their progress, the engineers and contractors who build them, and the daily records of the work (open works, daily reports, small works, site reports, labour), with a dashboard, an audit log, spreadsheet and PDF exports and spreadsheet imports. A modular monolith on Express 5, TypeScript, Prisma and PostgreSQL.

## Quick start

```bash
cp .env.example .env
docker compose up db -d
npm install
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

The API listens on `http://localhost:8080` under `/api/v1`. Health check: `GET /api/v1/health`. `.env.example` explains every setting; the full table is in [docs/operations.md](docs/operations.md#environment).

## The documents

| Read this                                              | When you want to                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/frontend-contract.md](docs/frontend-contract.md) | Build the frontend: conventions, sign-in and the refresh cookie, every resource's fields, filters, sorts and errors, the dashboard and audit shapes. |
| [docs/api.md](docs/api.md)                             | See every route: method, path, who may call it, whether it takes an `Idempotency-Key` or an `If-Match`.                                              |
| [docs/permissions.md](docs/permissions.md)             | Know which permission opens what, and how roles and the dashboard cards use them.                                                                    |
| [docs/errors.md](docs/errors.md)                       | Look up an error code and its status.                                                                                                                |
| [docs/imports-exports.md](docs/imports-exports.md)     | Use the twelve exports and the six spreadsheet imports: columns, limits, the import report.                                                          |
| [docs/write-safety.md](docs/write-safety.md)           | Retry safely (`Idempotency-Key`) and edit safely (`If-Match`); the rules for future money endpoints.                                                 |
| [docs/operations.md](docs/operations.md)               | Configure, deploy, back up and watch the service; the rate limits, the UTC day, the load check results.                                              |
| [docs/testing.md](docs/testing.md)                     | Run the suite, the database tests and the load check; how the documents are tested.                                                                  |

The documents are checked against the code by `npm test` (`tests/docs`): a route, permission, error code, environment variable, export column or DTO field that changes without its document fails the build.

## Scripts

- `npm run dev`: nodemon + tsx
- `npm run build` / `npm start`: compile and run
- `npm run lint` / `npm run format` / `npm run format:check`: eslint and prettier
- `npm run typecheck`
- `npm test`: the suite (no database needed)
- `npm run load:check`: the load check (see [docs/testing.md](docs/testing.md#the-load-check))
- `npm run idempotency:purge`: delete expired idempotency keys
- `npm run mail:preview`: render the password-reset email in English and Arabic
- `npx prisma migrate deploy`: apply migrations (`migrate dev` is for a development database only)
- `npx prisma db seed`: upsert the permission codes and, if no ADMIN exists, create one from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (idempotent)

## Docker

```bash
docker compose up --build
```

Runs `db`, a one-off `migrate` job, and `app`. Set `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` in `.env` first. See [docs/operations.md](docs/operations.md#docker) for what the `app` service still needs before a real deployment.
