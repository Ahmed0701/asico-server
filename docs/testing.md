# Testing

Four kinds of check, from the one that runs on every change to the one that is run on purpose.

| Check              | Command                                                                      | Needs a database       | What it answers                                                              |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| The suite          | `npm test`                                                                   | No                     | Does the code do what each module says, and do the documents still match it? |
| The database suite | `ASICO_DB_TESTS=1 npx vitest run tests/db`                                   | Yes (scratch schemas)  | Do the SQL, the locks, the triggers and the migrations behave on PostgreSQL? |
| The load check     | `npm run load:check` (with `ASICO_LOAD_CHECK=1`)                             | Yes (a scratch schema) | Is it fast enough with a realistic amount of data?                           |
| The static checks  | `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | No                     | Types, style, a clean build.                                                 |

CI runs the static checks, `npm test` and the build on every push, and builds the Docker images.

## The suite

`npm test` runs everything under `tests/` that ends in `.test.ts`. It needs no database and no network: the database is replaced by in-memory fakes, and mail is written to a file. It is safe to run at any time, as often as you like.

```
tests/
  core/        config, errors, i18n, idempotency, versions, rate limits, imports runner, mail, logging
  shared/      pagination and query helpers, the export writers (xlsx, pdf), the import reader and template
  prisma/      the schema and the migrations as text: names, additive-only rules, the seed
  modules/<m>/ one folder per module: routes (the HTTP contract, through the real Express app), service, entities
  docs/        the documents against the code (see below)
  db/          the database suite (skipped unless ASICO_DB_TESTS=1)
  load/        the load check (skipped unless ASICO_LOAD_CHECK=1; not found by `npm test`)
  helpers/     small test utilities
  setup/       the environment every test starts with
```

A module's route tests build the real application (`createApp()`) over an in-memory repository, sign a real access token, and call it with supertest. They check status, body, headers, the audit entry written and, where it matters, the language. A service test checks a rule in isolation. The in-memory repositories live beside the tests (`tests/modules/<m>/in-memory-*.repository.ts`) and honour the same rules as the SQL (uniqueness, versions, locks), so a rule is tested in both places.

**The cross-resource tests.** `tests/modules/exports/exports.cross-resource.test.ts` writes all twelve exports with the real spreadsheet and PDF writers and checks what every file must have in common (the header, the column widths, the cell formats, English, no formula a spreadsheet would run), so one export cannot drift from the others. The same file checks the seven import templates.

**The symmetry tests.** An exported file must be importable as it is (see [Exporting and importing again](imports-exports.md#exporting-and-importing-again)). `exports.header-drift.test.ts` compares the header of each of the seven exports with the columns of its import: the importable columns first, in order, then the informational ones, and the template with the importable ones only. `exports.round-trip.test.ts` writes tricky records with the real export, reads the file with the real import definition and the real runner, and compares what the repository was given with what the export was given (long texts, Arabic, guarded formulas, budgets in several currencies, areas and people that share a name, the open works' automatic items). `per-villa-imports.parse.test.ts` pins how the five per-villa imports read a villa number.

## The documents are tested

The documents in this folder describe the code, and `tests/docs` fails the build when they stop matching it:

| Test                           | Compares                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes.docs.test.ts`          | The route table of [api.md](api.md) with the Express routers: every method and path, the permission, idempotency and `If-Match` of each.                     |
| `permissions.docs.test.ts`     | [permissions.md](permissions.md) with the permission constants, the routes that use each, and the dashboard cards.                                           |
| `errors.docs.test.ts`          | [errors.md](errors.md) with every error code the source raises, and its status.                                                                              |
| `operations.docs.test.ts`      | [operations.md](operations.md) with the environment schema: every variable, every default.                                                                   |
| `contract.docs.test.ts`        | [frontend-contract.md](frontend-contract.md) with the DTO types, the list query schemas, the sort lists, the error codes and the dashboard and audit shapes. |
| `imports-exports.docs.test.ts` | [imports-exports.md](imports-exports.md) with the columns of the twelve exports and the seven import templates, and the limits.                              |
| `index.docs.test.ts`           | The README: every document is linked, every link resolves, every script named exists.                                                                        |

When one fails, the message names what differs. Fix whichever is wrong: the document, or (if the code changed on purpose) the document to follow it.

## The database suite

```bash
ASICO_DB_TESTS=1 npx vitest run tests/db
```

(PowerShell: `$env:ASICO_DB_TESTS = "1"; npx vitest run tests/db`.) It reads `DATABASE_URL` from `.env`.

- **Scratch schemas.** Each file creates a schema named `<prefix>_<12 hex digits>` on the database in `.env`, applies every migration to it, runs its tests there and drops it. The `asico` schema is never read or written, no database is created or reset, and `AuditLog` is never truncated.
- **Why a real database.** A rule that is a lock, a trigger, a unique index or a foreign key can only be tested where it lives: concurrent writers (the version check, the import's villa lock), the append-only audit trigger, the `CHECK` constraints, and the migrations themselves.
- **The migration tests** (`tests/db/*.migration.db.test.ts`) apply a migration on the real database inside a transaction that is rolled back, with rows in the tables it changes, so a backfill is checked on real data and a migration is proven before `migrate deploy` runs it for real.
- **The connection budget.** PostgreSQL allows 100 connections (about 97 for clients). The files run side by side, each with its own pool, and the pools together stay under it. The budget is written in `tests/db/scratch.ts`; a new database test file adds its pool to the sum there.
- Blank the `SMTP_*` and `MAIL_FROM` variables when you run anything against a real database, so nothing can send mail.

## Running the suite at another time of day

Some rules depend on the clock: the small works' overdue and due-soon flags change at midnight and 8 hours before the end of the day in `APP_TIMEZONE` (Asia/Kuwait, three hours ahead of UTC), while the other dates are UTC days. A test must never depend on the real time of day: those tests pin the clock to fixed instants (`vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime`). To prove it for the whole suite, run it as if it were another moment:

```bash
ASICO_TEST_NOW=2026-06-15T22:30:00Z npm test
```

(PowerShell: `$env:ASICO_TEST_NOW = "2026-06-15T22:30:00Z"; npm test`.) `tests/setup/shifted-clock.ts` shifts `Date` by a fixed offset taken once at the start, so the clock still ticks. Useful instants: `2026-06-15T02:00:00Z` (morning in Kuwait, same day as UTC), `2026-06-15T22:30:00Z` (already the next day in Kuwait) and `2026-12-31T23:30:00Z` (a year boundary). The variable is not set in normal runs.

## The load check

```bash
ASICO_LOAD_CHECK=1 npm run load:check
```

How it works, the numbers it measures and the thresholds are in [operations.md](operations.md#the-load-check). It is not part of `npm test`: it takes about ten minutes, writes 150,000 audit rows, and its answer depends on the machine.

## Mutation check

Before a slice is closed, the new code is mutated by hand-written scripts (flip a comparison, drop a guard, swap a constant, return early) and the suite is run against each mutant: a mutant that survives is a missing test. The scripts rewrite source files in place, so they are run in the working tree with nothing else editing it, and the tree is restored and re-verified (a hash of every touched file, then the type check and the whole suite) before anything else is done. The scripts are not part of the repository.

## Writing a test

- Test the behaviour at the HTTP edge first (`tests/modules/<m>/<m>.routes.test.ts`), then the rule that is hard to reach from there in a service test.
- A new route is documented in [api.md](api.md) or the docs test fails; a new error code in [errors.md](errors.md); a new variable in [operations.md](operations.md).
- A new test file that talks to a real database is guarded by `describe.skipIf(!RUN)` with `RUN = process.env.ASICO_DB_TESTS === "1"`, takes its schema from `openScratch`, and adds its pool size to the budget.
- Messages shown to people go through `en.json` and `ar.json`; a test checks that both files have the same keys.
