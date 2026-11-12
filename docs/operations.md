# Operations

How to run, configure, deploy and look after the API. For what the API does, see [api.md](api.md); for how to test it, [testing.md](testing.md).

## Running it

| What                                           | Command                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Development (auto-restart)                     | `npm run dev`                                               |
| Build, then run                                | `npm run build` then `npm start`                            |
| Type check, lint, format                       | `npm run typecheck`, `npm run lint`, `npm run format:check` |
| Apply migrations                               | `npx prisma migrate deploy`                                 |
| Create permissions and the first administrator | `npx prisma db seed`                                        |
| Remove expired idempotency rows                | `npm run idempotency:purge`                                 |

The API listens on `PORT` (8080) under `/api/v1`. `GET /api/v1/health` answers `200 {"status":"ok"}` when the database answers a `SELECT 1`, and `503 {"status":"degraded"}` when it does not (the Docker health check and a load balancer use it).

**Starting.** The process reads and checks the environment first. A missing or invalid variable prints one line per problem and exits with status 1: it never starts half configured.

**Stopping.** On `SIGTERM` or `SIGINT` the server stops accepting connections, finishes the requests in flight, closes the database pool and exits 0. If that takes longer than `SHUTDOWN_TIMEOUT_MS` it exits 1. An unhandled rejection or an uncaught exception is logged at `fatal` and shuts down the same way, with status 1, so the supervisor restarts a clean process.

## Environment

Every variable the application reads. A `.env` file (copy [.env.example](../.env.example)) fills them in development; in production set them in the environment of the process or container. `tests/docs/operations.docs.test.ts` checks this table against the schema in `src/core/config/env.ts`: a variable added there must be added here, and a default changed there must be changed here.

A blank value (`SMTP_PORT=`) means "not set".

| Variable                         | Default                                | Meaning                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                       | required                               | `development`, `test` or `production`. There is no default: forgetting it must not run production as development.                                                                                                                                                                                                  |
| `PORT`                           | `8080`                                 | The port the API listens on.                                                                                                                                                                                                                                                                                       |
| `DATABASE_URL`                   | required                               | The PostgreSQL URL, e.g. `postgresql://user:password@host:5432/asico?schema=public`.                                                                                                                                                                                                                               |
| `LOG_LEVEL`                      | `info`                                 | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                                                                                                                    |
| `UPLOAD_DIR`                     | `uploads`                              | Where villa documents are stored. Relative to the working directory, or absolute (`/srv/asico/uploads`). Keep it on a volume: it is the only state outside the database.                                                                                                                                           |
| `FILE_DELIVERY`                  | unset                                  | How a document download is sent: `stream` (the API sends the file) or `accel` (nginx sends it from an `internal` `/protected-files/` location that points at `UPLOAD_DIR`). Unset: `stream` in development, `accel` otherwise. Without that nginx location, use `stream`, or every download is an empty 0 KB file. |
| `MAX_UPLOAD_BYTES`               | `26214400`                             | The biggest document (25 MB).                                                                                                                                                                                                                                                                                      |
| `MAX_DOCUMENTS_PER_VILLA`        | `10`                                   | How many documents one villa may hold.                                                                                                                                                                                                                                                                             |
| `CORS_ORIGINS`                   | empty                                  | Comma-separated browser origins allowed to call the API with credentials. Empty allows none.                                                                                                                                                                                                                       |
| `TRUST_PROXY`                    | `0`                                    | How many reverse proxies sit in front (1 behind nginx). Wrong, and every client looks like the proxy: rate limits and audit IPs are then wrong.                                                                                                                                                                    |
| `BODY_LIMIT`                     | `100kb`                                | The biggest JSON body.                                                                                                                                                                                                                                                                                             |
| `RATE_LIMIT_WINDOW_MS`           | `60000`                                | The window of the global limiter.                                                                                                                                                                                                                                                                                  |
| `RATE_LIMIT_MAX`                 | `300`                                  | Requests per window per client IP, over the whole API.                                                                                                                                                                                                                                                             |
| `EXPORT_RATE_LIMIT_WINDOW_MS`    | `60000`                                | The window of the export limiter.                                                                                                                                                                                                                                                                                  |
| `EXPORT_RATE_LIMIT_MAX`          | `10`                                   | Exports per window per user.                                                                                                                                                                                                                                                                                       |
| `IMPORT_RATE_LIMIT_WINDOW_MS`    | `60000`                                | The window of the import limiter.                                                                                                                                                                                                                                                                                  |
| `IMPORT_RATE_LIMIT_MAX`          | `10`                                   | Imports (and template downloads) per window per user.                                                                                                                                                                                                                                                              |
| `DB_POOL_MAX`                    | `10`                                   | Connections in the pool of one process. Replicas multiply it: keep `replicas x DB_POOL_MAX` under PostgreSQL's `max_connections`, with room for the migration job and your own `psql`.                                                                                                                             |
| `DB_CONNECTION_TIMEOUT_MS`       | `5000`                                 | How long a request waits for a free connection before it fails.                                                                                                                                                                                                                                                    |
| `DB_IDLE_TIMEOUT_MS`             | `30000`                                | How long an idle connection is kept.                                                                                                                                                                                                                                                                               |
| `SHUTDOWN_TIMEOUT_MS`            | `10000`                                | How long a shutdown may take before it is forced.                                                                                                                                                                                                                                                                  |
| `APP_TIMEZONE`                   | `Asia/Kuwait`                          | The IANA time zone in which a small work ends at the end of its `endDate`. Checked at startup: a name the runtime does not know (or a fixed offset such as `+03:00`) stops the server. See [Small work deadlines](#small-work-deadlines-and-alerts).                                                               |
| `SMALL_WORKS_ALERT_HOURS_BEFORE` | `8`                                    | A pending small work is "due soon" this many hours before the end of its `endDate`. A whole number from 1 to 72.                                                                                                                                                                                                   |
| `SMALL_WORKS_ALERT_JOB_ENABLED`  | `true`                                 | Whether this process runs the hourly alert job. `true` or `false`. The tests set it to `false`.                                                                                                                                                                                                                    |
| `JWT_ACCESS_SECRET`              | required                               | Signs the access tokens: at least 32 characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out.                                                                                                                                       |
| `JWT_ACCESS_TTL_SECONDS`         | `900`                                  | The life of an access token (15 minutes).                                                                                                                                                                                                                                                                          |
| `REFRESH_TOKEN_TTL_DAYS`         | `7`                                    | The life of a refresh token, and so of a session that is not used.                                                                                                                                                                                                                                                 |
| `AUTH_RATE_LIMIT_WINDOW_MS`      | `900000`                               | The window of the sign-in and password limiters.                                                                                                                                                                                                                                                                   |
| `AUTH_RATE_LIMIT_MAX`            | `10`                                   | Requests per window per client IP, counted for each of `/auth/signup`, `/auth/login`, `/auth/forgot-password` and `/auth/reset-password` on its own.                                                                                                                                                               |
| `REFRESH_RATE_LIMIT_WINDOW_MS`   | `60000`                                | The window of the refresh limiter.                                                                                                                                                                                                                                                                                 |
| `REFRESH_RATE_LIMIT_MAX`         | `30`                                   | Refreshes per window per client IP. Wider than the others: every open tab refreshes when the access token expires.                                                                                                                                                                                                 |
| `REFRESH_COOKIE_SECURE`          | unset                                  | `true` or `false`. Unset means on everywhere except development. `false` is refused in production.                                                                                                                                                                                                                 |
| `AUTH_SIGNUP_ENABLED`            | unset                                  | `true` or `false`: public sign-up (`POST /auth/signup`). Unset means on everywhere except production, where only an administrator creates users (`403 SIGNUP_DISABLED`).                                                                                                                                           |
| `REFRESH_COOKIE_SAMESITE`        | `strict`                               | `strict` (the frontend and the API on one site), `lax`, or `none` (a frontend on another site; needs Secure).                                                                                                                                                                                                      |
| `REFRESH_COOKIE_DOMAIN`          | unset                                  | A bare host name such as `example.com`, only when the frontend shares a parent domain. Unset: the cookie belongs to the API host alone.                                                                                                                                                                            |
| `PASSWORD_RESET_URL`             | `http://localhost:5173/reset-password` | The **frontend** page the reset link opens (`?token=...` is added). Not an API URL.                                                                                                                                                                                                                                |
| `SMTP_HOST`                      | unset                                  | The mail server. All six of `SMTP_*` and `MAIL_FROM` together or none; required in production.                                                                                                                                                                                                                     |
| `SMTP_PORT`                      | unset                                  | 465 with `SMTP_SECURE=true`, or 587 with `false` (STARTTLS).                                                                                                                                                                                                                                                       |
| `SMTP_SECURE`                    | unset                                  | `true` or `false`.                                                                                                                                                                                                                                                                                                 |
| `SMTP_USER`                      | unset                                  | The account (for Gmail, the address).                                                                                                                                                                                                                                                                              |
| `SMTP_PASS`                      | unset                                  | The password (for Gmail, an App Password: 16 characters, no spaces).                                                                                                                                                                                                                                               |
| `MAIL_FROM`                      | unset                                  | `"Elecico <you@example.com>"`. With Gmail it must be the `SMTP_USER` address.                                                                                                                                                                                                                                      |

Also read, but not part of the application's schema:

| Variable            | Used by                                 | Meaning                                                                                        |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ADMIN_EMAIL`       | `npx prisma db seed`                    | The first administrator's email. The seed is idempotent: it creates one only when none exists. |
| `ADMIN_PASSWORD`    | `npx prisma db seed`                    | Their password. Change it after the first sign-in.                                             |
| `POSTGRES_USER`     | `docker-compose.yml` (the `db` service) | The database user the compose stack creates and the app connects as.                           |
| `POSTGRES_PASSWORD` | `docker-compose.yml`                    | Its password.                                                                                  |
| `POSTGRES_DB`       | `docker-compose.yml`                    | The database name.                                                                             |

### Production checklist

- `NODE_ENV=production`; `JWT_ACCESS_SECRET` from a secret store, never the example value.
- All of `SMTP_*` and `MAIL_FROM` (the process refuses to start without them: password-reset emails go through them).
- `CORS_ORIGINS` is the frontend's origin(s), exactly; `TRUST_PROXY=1` behind one proxy. The API exposes `ETag`, `Retry-After`, `Idempotent-Replayed`, `X-Request-Id` and `Content-Disposition` to those origins (`Access-Control-Expose-Headers`), so a frontend can read the request id and name a download; a proxy in front must pass them through unchanged.
- HTTPS end to end: the refresh cookie is `Secure` outside development, and a browser does not send it over plain HTTP.
- `PASSWORD_RESET_URL` is the frontend's reset page on its real host.
- `DATABASE_URL` is a role that owns the application's tables but is not a superuser.
- `UPLOAD_DIR` is on a volume that is backed up with the database.

## Rate limits

Each limiter keeps its counters in the process's memory, per instance: with more than one replica, each replica counts for itself (give the limiters a shared store before scaling out, or put the limit in the proxy as well).

| Limiter | Applies to                                                                                       | Counted per                  | Default           |
| ------- | ------------------------------------------------------------------------------------------------ | ---------------------------- | ----------------- |
| Global  | Every request                                                                                    | Client IP                    | 300 per minute    |
| Auth    | `/auth/signup`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password` (each on its own) | Client IP                    | 10 per 15 minutes |
| Refresh | `/auth/refresh`                                                                                  | Client IP                    | 30 per minute     |
| Export  | Every `.../export`                                                                               | User (IP when not signed in) | 10 per minute     |
| Import  | Every `.../import` and `.../import/template`                                                     | User (IP when not signed in) | 10 per minute     |

A request over its limit gets `429 TOO_MANY_REQUESTS` with `Retry-After` (seconds) and the standard `RateLimit` and `RateLimit-Policy` headers.

## The UTC day

Every date and time in the API is UTC. Calendar days (`reportDate`, `targetDate`, ...) are plain `YYYY-MM-DD` values that the server never shifts: what a person types is what is stored and shown.

The one place the server decides what "today" is, is its own clock, and it uses the **UTC day**: the dashboard's "today" and "last 7 days" figures, "overdue" (a target or end date before today) on the dashboard and on the open-works list, and "upcoming" (the next 30 days) on the dashboard. A site in Cairo (UTC+2, or UTC+3 in summer) therefore sees the new day start at 02:00 or 03:00 local time: a report written at 01:00 local belongs to the previous UTC day's figures, and a villa due "today" local is still due "tomorrow" until then. This is a deliberate limitation, not a bug: it keeps every figure reproducible whoever asks and wherever they are. A later change can add a `TZ` setting for the business day without changing the API's shape.

The one exception is the deadline of a daily small work, which is counted in `APP_TIMEZONE` (below). Nothing else uses that setting: "today" everywhere else, including the other figures of the dashboard, is still the UTC day.

## Small work deadlines and alerts

A small work has a `startDate` and an `endDate` (calendar days). Its **deadline** is the end of its `endDate` in `APP_TIMEZONE`, that is the first instant of the next day there. For `endDate` 2026-11-05 in `Asia/Kuwait` (UTC+3, no daylight saving) with `SMALL_WORKS_ALERT_HOURS_BEFORE=8`:

| Instant (Kuwait)        | Instant (UTC)           | A pending work is |
| ----------------------- | ----------------------- | ----------------- |
| before 2026-11-05 16:00 | before 2026-11-05 13:00 | neither           |
| from 2026-11-05 16:00   | from 2026-11-05 13:00   | due soon          |
| from 2026-11-06 00:00   | from 2026-11-05 21:00   | overdue           |

A work that is `DONE` is neither. The API, the list filters (`overdue`, `dueSoon`), the dashboard and the job all decide this from the same two calendar days of the zone, so they cannot disagree. Days are real days of the zone: on a day the clocks change, the day is 23 or 25 hours long and the deadline moves with it.

**The alert job** runs once when the server starts and then every hour, in the API process, when `SMALL_WORKS_ALERT_JOB_ENABLED` is `true`. Each run has two phases, each in its own transaction that starts by taking a PostgreSQL advisory lock (`pg_try_advisory_xact_lock`, name `SmallWorks.alertJob`, without waiting); if another instance holds it the phase is skipped, so any number of replicas raise each notification once and send each digest once:

1. **Raise.** Finds the pending works that are due soon or overdue and have no notification yet for their situation, and writes one notification per situation, with a copy (and its own read state) for every active administrator and every active user with `small-works:read`. A situation is **(small work, kind, `endDate`)**, a unique key: a work gets at most one "due soon" and one "overdue" notification for each end date it has had. A work whose end date is moved gets fresh ones for the new date; a work moved back to `PENDING` with the same end date does not repeat what it already raised; a `DONE` work raises nothing.
2. **Email.** Sends **one digest email** to every active administrator with everything not yet emailed (`emailedAt`), in English and Arabic, through the same mailer as the password reset. A notification counts as emailed (`emailedAt`) once at least one administrator was sent the digest; when every send fails it stays unsent and the next run tries again (a run that raised nothing still retries). A failure is logged without the address and never stops the job or the server, and a notification already emailed is never sent again. An administrator whose own send failed while another succeeded is not retried. With the SMTP variables blank in development the digest is written to the outbox file, as every other email.

Run it by hand, outside HTTP, with `npm run jobs:small-works`: it prints what it raised and sent, and exits 0 (1 on an error). It is safe to run while the server is running.

Notifications are read through `GET /notifications` (see [api.md](api.md)); marking them read is not audited.

## Database

PostgreSQL 16 or newer. The schema is in `prisma/schema.prisma`; the changes are in `prisma/migrations`:

- `init` is generated by Prisma; every other migration is **hand-written, additive SQL** (new tables, new nullable columns, new indexes): nothing that rewrites or drops existing data, so a deployment can be rolled back by deploying the previous image while the new columns sit unused. **The one exception is slice 19** (`20261111090000_slice19_schema`, below): it drops columns, so it cannot be rolled back by deploying the previous image.
- `npx prisma migrate deploy` applies what is missing and is safe to run on every release (the compose stack runs it as a one-off `migrate` service before the app starts). `migrate dev` and `migrate reset` are for a development database only: never run them against a database that holds real data.
- A migration is tested before it is deployed: in a scratch schema (all migrations applied, then the new one), inside a transaction that is rolled back. The database tests under `tests/db` do this (see [testing.md](testing.md)).

### The slice 19 migration (read before deploying)

`prisma/migrations/20261111090000_slice19_schema` changes three tables and **drops data**:

- **Open works** (`WorkItem`): every open work is filed under a required electrical phase. A manual item gets the phase whose name equals its old work phase (`FOUNDATION`, `STRUCTURE`, `MEP`, `FINISHING`, `EXTERNAL`), ignoring case and surrounding spaces; an item that already has a phase keeps it. The `title` and the `phase` columns and the `WorkPhase` type are dropped: **the titles of manual open works are lost** (there is no description field).
- **Small works** (`DailySmallWork`): `qty` and `unit` are dropped.
- **Daily reports** (`DailyReport`): a report belongs to a contractor (its own, else its villa's) and to the electrical engineer whose name equals the old `preparedBy` text (ignoring case and surrounding spaces). `villaId`, `workDone` and `preparedBy` are dropped, `issues` is renamed `notes`, and the report is unique per `(contractor, date)`.

**It stops instead of guessing.** Before it changes anything it looks for rows it cannot place and, if there are any, fails with one message that lists them all (`Slice 19 stopped, nothing was changed ...`); the transaction is rolled back, so the database is exactly as it was. The cases are: a manual open work whose old work phase matches no electrical phase (or more than one); a daily report whose villa has no contractor and which has none of its own; two reports that would belong to the same contractor on the same day (they are never merged); a report whose `preparedBy` matches no electrical engineer (or more than one).

**Check first, read only:**

```bash
npm run check:slice19
```

It prints the database it is looking at, then every row the migration would stop on (`[OPEN_WORK_PHASE]`, `[REPORT_NO_CONTRACTOR]`, `[REPORT_COLLISION]`, `[REPORT_ENGINEER]`), one line each, and exits `0` when there is nothing to fix and `1` when there is. It runs in a read-only transaction that is rolled back, so it cannot change anything. Fix the rows (give the open work an electrical phase or delete it, add the engineer or correct the text, give the villa a contractor, delete the extra reports), run it again until it is clean, **take a backup**, and only then run `npx prisma migrate deploy`.

**Cleanup of the two rows asico has**, for this one database only (the check found them; their ids are fixed in the script):

```bash
npm run cleanup:slice19          # a dry run: names the database and what it would delete, changes nothing
npm run cleanup:slice19 -- --yes # deletes them
```

It works on the **old** schema (it uses the old column names) and refuses once the migration is applied. With `--yes` it deletes, in one transaction, the manual open work `4d288d32-537d-4d47-8bcf-233dd278105b` (work phase MEP, no electrical phase of that name) and the daily report `3c1dfab4-b006-4e10-a897-58d1c036ca0f` (prepared by "Administrator1", no engineer of that name), each only if it still matches that problem; a row that changed is refused and left alone. It adds one audit entry per deletion (`open_work.delete`, `daily_report.delete`, no actor, the old row as `before`) and never touches existing audit rows. It then runs the same checks as `check:slice19` and prints what is left. Exit `0`: done and clean; `1`: a row was refused or the check still finds other rows. Take the backup before `--yes`.

The frontend must ship with this release (the API shapes of open works, daily reports, small works, the dashboard and the contractor summary changed: see [frontend-contract.md](frontend-contract.md)). The migration was tested in a rolled-back scratch schema (`tests/db/slice19.migration.db.test.ts`); it has not been run on the real database by the developer.

- **`AuditLog` is append-only**, enforced by a trigger: an `UPDATE` or `DELETE` is rejected by the database itself. Do not disable the trigger or truncate the table.
- Writes are made safe by row versions and idempotency keys: see [write-safety.md](write-safety.md).

**Backup.** The state is the database and `UPLOAD_DIR`. Back both up together (the documents are rows plus files):

```bash
pg_dump --format=custom --file=elecico-$(date +%F).dump "$DATABASE_URL"
```

and restore into an empty database with `pg_restore --clean --if-exists --dbname=<url> elecico-<date>.dump`. Test a restore before you need one.

## Docker

```bash
docker compose up --build
```

runs three services: `db` (PostgreSQL), `migrate` (a one-off job that applies the migrations and exits) and `app` (the API, as the unprivileged `node` user, with a health check on `/api/v1/health`). The `app` and `db` ports are bound to `127.0.0.1`: the API is meant to sit behind a reverse proxy that terminates TLS.

`docker-compose.yml` passes the `app` service **only** the variables it lists (`NODE_ENV`, `PORT`, `DATABASE_URL`, `LOG_LEVEL`, `UPLOAD_DIR`, `CORS_ORIGINS`, `TRUST_PROXY`). The application also needs these, so add them under `app.environment` before a real deployment, each as `NAME: ${NAME}` with the value in `.env`:

```yaml
JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?set JWT_ACCESS_SECRET in .env}
PASSWORD_RESET_URL: ${PASSWORD_RESET_URL:?set PASSWORD_RESET_URL in .env}
SMTP_HOST: ${SMTP_HOST:?set SMTP_HOST in .env}
SMTP_PORT: ${SMTP_PORT:?set SMTP_PORT in .env}
SMTP_SECURE: ${SMTP_SECURE:?set SMTP_SECURE in .env}
SMTP_USER: ${SMTP_USER:?set SMTP_USER in .env}
SMTP_PASS: ${SMTP_PASS:?set SMTP_PASS in .env}
MAIL_FROM: ${MAIL_FROM:?set MAIL_FROM in .env}
REFRESH_COOKIE_SAMESITE: ${REFRESH_COOKIE_SAMESITE:-strict}
REFRESH_COOKIE_DOMAIN: ${REFRESH_COOKIE_DOMAIN:-}
```

and any limit or timeout you want to change from its default.

## Email

Password reset links are sent by email (`POST /auth/forgot-password`, and `POST /users/:id/reset-password` for an administrator). Set the six SMTP variables (see the table above); in production the app does not start without them. For Gmail:

- Use an **App Password**, not the account password. App Passwords require **2-Step Verification** to be on for the Google account (Google Account → Security → App passwords). The password is 16 characters; enter it without spaces.
- `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` with `SMTP_SECURE=true` (or `587` with `SMTP_SECURE=false`, which uses STARTTLS), `SMTP_USER` is the Gmail address, and `MAIL_FROM="Elecico <the same address>"`. Gmail rewrites any other From address, so `MAIL_FROM` must be the authenticated account.
- Gmail limits sending to roughly 500 emails a day, which is enough for this internal system. The forgot-password endpoint also sends at most one email a minute per user.
- Without SMTP in development, the email is written to `asico-mail-outbox` in the system temp folder and only the file path is logged. Neither the link nor `SMTP_PASS` is ever written to the log.
- `npm run mail:preview` renders the email in English and Arabic into `asico-mail-preview` in the system temp folder, to open in a browser.
- Anything you run against a real database for a check (tests, a load check) should have the `SMTP_*` and `MAIL_FROM` variables blank, so nothing can send mail.

## Logs

Logs are JSON lines (pino) on stdout. Every request has an id (`X-Request-Id` in the response, `requestId` in an error body and in the log lines it caused). Passwords, tokens, cookies, the `Authorization` header, mail credentials and reset links are redacted. Set `LOG_LEVEL=debug` for more; do not leave it there.

An `unhandled error` line at `error` level is a 500: its `requestId` is what the user reports.

## Housekeeping

| Task                         | How                         | How often                                                                                                      |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Expired idempotency rows     | `npm run idempotency:purge` | Daily from cron, a scheduled task or CI. Safe at any time; a few thousand rows cost nothing.                   |
| Old refresh and reset tokens | none yet                    | They are inert once expired or used, and small; a purge can be added when the tables are worth worrying about. |
| Uploaded documents           | with the database backup    | Deleting a document deletes its file; an orphan file left by a crash is harmless.                              |

## The load check

How fast is it with a realistic amount of data? `npm run load:check` (with `ASICO_LOAD_CHECK=1`, see [testing.md](testing.md#the-load-check)) answers with numbers instead of a feeling. It is not part of `npm test`.

### How it measures

- **A scratch schema, never the real one.** The disk's free space is checked first (below 5 GB nothing is created). A schema named `load14b_<random>` is built on the local database with every migration applied, filled, measured and dropped in a `finally`, whatever happened. The name is asserted before anything is created and again before the drop, and it can never be `public` or contain `asico`. After the data is made, the application is asked what it sees; if that is not the scratch schema, the run stops before it measures or writes anything. The row counts of the real tables are compared before and after.
- **The real application, in process.** The Express app runs against the scratch schema with an ADMIN token, through HTTP (supertest), with a pool of 10 connections.
- **The data:** 400 villas, 40 contractors, 20 areas, 8 phases, 120 days of records for every villa (48,000 daily reports, 48,000 daily labour rows, 24,000 small works), 10,000 open works, 10,000 site reports and 150,000 audit rows. The scratch schema is about 210 MB while it exists.
- **What is run:** every list (a page of 20, the largest page, a sort, a filter, a search), every detail and options route, the dashboard, a handful of writes, each export at its 10,000-row cap as a spreadsheet and as a PDF (with the memory it takes and how long it blocks the event loop), and an import and dry run of five resources (2,000 rows each; the villas also at 400 rows). Reads run 30 times after 5 warm-up calls, exports and imports 10 times, writes 30 times.
- **The slowest queries get `EXPLAIN (ANALYZE, BUFFERS)`** in the report, so a number over its limit comes with the plan that explains it.

### The limits

The limit is on the **p95**, in milliseconds. A measure over its limit is reported as `OVER`; the run never fails for it, because the answer depends on the machine.

| Measure                               | Limit (p95)     |
| ------------------------------------- | --------------- |
| A list, a detail, an options route    | 300             |
| A search                              | 500             |
| The dashboard summary                 | 500             |
| A write (create, change, delete)      | 200             |
| An export at 10,000 rows, xlsx / pdf  | 15,000 / 30,000 |
| An import of 2,000 rows / its dry run | 10,000 / 5,000  |
| Memory growth during one export       | 300 MB          |
| Event loop blocked during one export  | 200 ms          |

### What it found (400 villas, 120 days, this machine)

All figures are milliseconds. Reads were measured again after the search change below; writes, exports and imports are from the full run.

| Measure                                              | p50     | p95     | Limit        |
| ---------------------------------------------------- | ------- | ------- | ------------ |
| `GET /villas` (a page of 20)                         | 15.5    | 23.1    | 300          |
| `GET /villas` sorted by progress                     | 27.3    | 34.4    | 300          |
| `GET /villas` (all 400 at once)                      | 39.6    | 50.8    | 300          |
| `GET /villas/:id`                                    | 7.5     | 10.2    | 300          |
| `GET /dashboard/summary`                             | 49.8    | 57.6    | 500          |
| `GET /open-works` (1,000 at once)                    | 95.6    | 119.8   | 300          |
| `GET /daily-reports` (1,000 at once)                 | 78.2    | 112.7   | 300          |
| `GET /daily-labour` (1,000 at once)                  | 87.5    | 155.7   | 300          |
| `GET /small-works` (1,000 at once)                   | 56.0    | 77.0    | 300          |
| `GET /site-reports` (1,000 at once)                  | 56.3    | 69.0    | 300          |
| `GET /audit-logs` (a page of 20, 150,000 rows)       | 23.8    | 35.2    | 300          |
| `GET /audit-logs/filters`                            | 83.2    | 173.8   | 300          |
| `GET /daily-reports?search=` (1 row in 120 matches)  | 15.8    | 20.5    | 500          |
| `GET /daily-reports?search=` (a villa number)        | 11.4    | 14.0    | 500          |
| `GET /daily-reports?search=` (nothing matches)       | 6.7     | 8.4     | 500          |
| `GET /daily-reports?search=` (**every row matches**) | 646.3   | 856.8   | 500 **OVER** |
| `GET /daily-labour?search=`                          | 251.1   | 294.3   | 500          |
| `GET /small-works?search=`                           | 110.8   | 133.4   | 500          |
| `GET /site-reports?search=`                          | 36.7    | 47.8    | 500          |
| `POST /daily-reports`                                | 15.6    | 24.1    | 200          |
| `PATCH /villas/:id/phases/:id`                       | 12.0    | 15.2    | 200          |
| Dry run of 2,000 daily reports                       | 412.1   | 526.1   | 5,000        |
| Import of 2,000 daily reports                        | 1,462.1 | 1,863.4 | 10,000       |
| Dry run of 400 villas                                | 168.9   | 210.8   | 5,000        |
| Import of 400 villas                                 | 946.1   | 1,243.6 | 10,000       |
| Dry run of 2,000 villas                              | 361.8   | 379.8   | 5,000        |
| Import of 2,000 villas                               | 4,288.4 | 4,637.7 | 10,000       |
| Export of 10,000 daily reports, xlsx                 | 1,528.6 | 1,601.6 | 15,000       |
| Export of 10,000 daily reports, pdf                  | 5,030.4 | 5,628.2 | 30,000       |
| Export of 10,000 open works, pdf (the slowest)       | 4,308.2 | 7,484.2 | 30,000       |

Every other list, detail, options route, write, import and export was under its limit with room to spare; the full table is in the report the run writes (`LOAD_REPORT=<file>` names where).

### Known limits

- **Searching daily reports for a word that is in every row** takes about 650 ms (p95 about 860): the database has to read and test all 48,000 rows, and no index can make "everything matches" cheaper. A search that rules rows out is fast (under 25 ms).
- **Exports block the event loop.** A 10,000-row export blocks it for 400 to 900 ms at a time (limit 200), because building the file runs on the main thread; other requests to the same instance wait meanwhile. Memory grows by up to 270 MB for a 10,000-row PDF of daily reports (limit 300). An export is limited to 10 a minute per user; moving file building to a worker thread (or yielding between batches of rows) is the remedy if exports become frequent.
- **The villa import is the slowest import** (about 2 ms a row, 4.6 s at p95 for 2,000 villas, limit 10 s), because every villa also gets a progress row for each phase and an audit entry of its own, all in the one transaction. The file cap is 2,000 rows, so this is the worst case.
- **`GET /audit-logs/filters`** reads the whole log to list the actions, entities and users it contains (174 ms at 150,000 rows). It grows with the log; if the log grows by an order of magnitude, keep these lists in a small table instead.
- **A search that spans a join** (a daily labour search by contractor name, a small works search by villa number or contractor, an open works search by villa number, phase or contractor) cannot use the trigram indexes because of the `OR` across tables; they cost 130 to 300 ms at this size and grow with the table. The daily reports search no longer spans a join (it looks in the notes only, see below); the others can follow if their tables grow.

### The daily reports search

Before the load check, `GET /daily-reports?search=` took 826 to 857 ms (p95 936 to 956) for every kind of search, even one that matched nothing. The search was one `OR` over four columns, one of them the villa's number from a joined table, and PostgreSQL cannot use an index when a single `OR` reaches across a join, so it read every report.

The fix changes the query, not the result: the villa number is looked up first, on its own, and the reports are found with `"villaId" = ANY (...)`; the report columns are searched with trigram indexes (`DailyReport_issues_trgm_idx` and `DailyReport_preparedBy_trgm_idx` are new, migration `20261108090000_daily_report_search_indexes`, alongside the existing one on `workDone`); and the matching rows are materialised before the villa join. A search that rules rows out now takes 6.7 to 15.8 ms (p95 8.4 to 20.5), 50 to 125 times faster. The migration only adds two indexes; it was proven on a rolled-back scratch schema (including that the planner chooses the index with 20,000 more rows present) before it was deployed.
