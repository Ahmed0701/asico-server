# API reference

Every route of the API, once. Fields, filters, sorts and error codes of each resource are in [frontend-contract.md](frontend-contract.md); the permissions in [permissions.md](permissions.md); the error codes in [errors.md](errors.md); the spreadsheet routes in [imports-exports.md](imports-exports.md).

All paths are under `/api/v1`. A test (`tests/docs/routes.docs.test.ts`) reads the routers as they are mounted and fails when this page and the code disagree about a route, who may call it, or whether it takes an `Idempotency-Key` or an `If-Match`.

## Conventions

| Topic             | Rule                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in           | `Authorization: Bearer <accessToken>`. The access token comes from `POST /auth/login` and is renewed with `POST /auth/refresh`, which uses the refresh cookie (see the contract).                                                                                                                                                                                             |
| Access column     | A permission code (the caller needs it; ADMIN has them all), `signed in` (any signed-in user) or `public` (no token).                                                                                                                                                                                                                                                         |
| Success           | `{ "data": ... }`, and for a list `{ "data": [...], "meta": { "page", "limit", "total", "totalPages" } }`. A delete answers `204` with no body.                                                                                                                                                                                                                               |
| Failure           | `{ "code", "message", "details"?, "requestId" }`. The `message` is in the language of the request; branch on `code`.                                                                                                                                                                                                                                                          |
| Language          | `Accept-Language: ar` or `en` (default `en`). Messages, labels and exports follow it.                                                                                                                                                                                                                                                                                         |
| `X-Request-Id`    | Returned on every response and repeated in the error body. Send it to support with a report.                                                                                                                                                                                                                                                                                  |
| Pagination        | `page` (from 1) and `limit` (1 to 1000, default 20). A value out of range or not a number answers 400; it is never clamped.                                                                                                                                                                                                                                                   |
| `Idempotency-Key` | 8 to 255 characters from `A-Za-z0-9._:-` (a UUID will do). **optional**: repeating the request with the same key gets the first answer again. **required**: the seven imports; without it the request answers 400 `IDEMPOTENCY_KEY_REQUIRED`. The same key on a different request answers 422 `IDEMPOTENCY_KEY_REUSED`; on one still running, 409 `IDEMPOTENCY_IN_PROGRESS`.  |
| `If-Match`        | The version taken from the `ETag` of a read (`"3"`, `3` and `W/"3"` are all read the same way). **optional** everywhere: with it, a write on a version that is no longer current answers 409 `VERSION_CONFLICT` and names the current version; without it the write goes through. An unreadable value answers 400 `INVALID_IF_MATCH`. See [write-safety.md](write-safety.md). |
| `—`               | The route does not take that header.                                                                                                                                                                                                                                                                                                                                          |

## Routes

### Health

| Method | Path      | Access   | Idempotency-Key | If-Match | Purpose                                                                                                                    |
| ------ | --------- | -------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health` | `public` | —               | —        | Health check: 200 `{"status":"ok"}`, or 503 `{"status":"degraded"}` when the database does not answer (no `data` envelope) |

### Sign-in and account

| Method  | Path                    | Access      | Idempotency-Key | If-Match | Purpose                                                                                                  |
| ------- | ----------------------- | ----------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `POST`  | `/auth/signup`          | `public`    | —               | —        | Register an account: an EMPLOYEE, inactive until an administrator activates it, so it cannot sign in yet |
| `POST`  | `/auth/login`           | `public`    | —               | —        | Sign in; returns the access token and sets the refresh cookie                                            |
| `POST`  | `/auth/refresh`         | `public`    | —               | —        | Exchange the refresh cookie for a new access token (the refresh token rotates)                           |
| `POST`  | `/auth/logout`          | `public`    | —               | —        | Revoke the refresh token and clear the cookie                                                            |
| `POST`  | `/auth/forgot-password` | `public`    | —               | —        | Email a reset link (answers the same whether or not the address is known; one email a minute per user)   |
| `POST`  | `/auth/reset-password`  | `public`    | —               | —        | Set a new password with the emailed token; signs every session out                                       |
| `POST`  | `/auth/change-password` | `signed in` | —               | —        | Change your own password; every other session is signed out                                              |
| `GET`   | `/me`                   | `signed in` | —               | —        | Your profile and your permission codes                                                                   |
| `PATCH` | `/me`                   | `signed in` | —               | —        | Change your own name                                                                                     |

### Users and permissions

| Method   | Path                        | Access               | Idempotency-Key | If-Match | Purpose                                                                                                                      |
| -------- | --------------------------- | -------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/users`                    | `users:read`         | —               | —        | List users (page, search, role, isActive, sort)                                                                              |
| `GET`    | `/users/:id`                | `users:read`         | —               | —        | One user                                                                                                                     |
| `POST`   | `/users`                    | `users:create`       | optional        | —        | Create an EMPLOYEE; granting `permissions` in the same request needs `permissions:assign` too                                |
| `PATCH`  | `/users/:id`                | `users:update`       | —               | optional | Change a user's name or email                                                                                                |
| `POST`   | `/users/:id/reset-password` | `users:update`       | optional        | —        | Email a user a reset link and sign out all their sessions                                                                    |
| `PATCH`  | `/users/:id/activate`       | `users:deactivate`   | —               | optional | Re-activate a user                                                                                                           |
| `PATCH`  | `/users/:id/deactivate`     | `users:deactivate`   | —               | optional | Deactivate a user and revoke their sessions (not an ADMIN, not yourself)                                                     |
| `DELETE` | `/users/:id`                | `users:delete`       | —               | optional | Delete a user for good (not an ADMIN, not yourself, not one who created villas or uploaded villa documents: deactivate them) |
| `GET`    | `/permissions`              | `permissions:assign` | —               | —        | Every permission code, grouped by resource                                                                                   |
| `GET`    | `/users/:id/permissions`    | `permissions:assign` | —               | —        | The permissions granted to a user                                                                                            |
| `PUT`    | `/users/:id/permissions`    | `permissions:assign` | —               | —        | Replace the permissions of an EMPLOYEE                                                                                       |

### Civil engineers

| Method   | Path                       | Access                   | Idempotency-Key | If-Match | Purpose                                           |
| -------- | -------------------------- | ------------------------ | --------------- | -------- | ------------------------------------------------- |
| `GET`    | `/civil-engineers`         | `civil-engineers:read`   | —               | —        | List civil engineers (page, filters, sort)        |
| `GET`    | `/civil-engineers/options` | `civil-engineers:read`   | —               | —        | Id and name of every civil engineer, for a picker |
| `GET`    | `/civil-engineers/:id`     | `civil-engineers:read`   | —               | —        | One civil engineer                                |
| `POST`   | `/civil-engineers`         | `civil-engineers:create` | optional        | —        | Create a civil engineer                           |
| `PATCH`  | `/civil-engineers/:id`     | `civil-engineers:update` | —               | optional | Change a civil engineer                           |
| `DELETE` | `/civil-engineers/:id`     | `civil-engineers:delete` | —               | optional | Delete a civil engineer                           |

### Electrical engineers

| Method   | Path                            | Access                        | Idempotency-Key | If-Match | Purpose                                                |
| -------- | ------------------------------- | ----------------------------- | --------------- | -------- | ------------------------------------------------------ |
| `GET`    | `/electrical-engineers`         | `electrical-engineers:read`   | —               | —        | List electrical engineers (page, filters, sort)        |
| `GET`    | `/electrical-engineers/options` | `electrical-engineers:read`   | —               | —        | Id and name of every electrical engineer, for a picker |
| `GET`    | `/electrical-engineers/:id`     | `electrical-engineers:read`   | —               | —        | One electrical engineer                                |
| `POST`   | `/electrical-engineers`         | `electrical-engineers:create` | optional        | —        | Create an electrical engineer                          |
| `PATCH`  | `/electrical-engineers/:id`     | `electrical-engineers:update` | —               | optional | Change an electrical engineer                          |
| `DELETE` | `/electrical-engineers/:id`     | `electrical-engineers:delete` | —               | optional | Delete an electrical engineer                          |

### Electrical phases

| Method   | Path                   | Access               | Idempotency-Key | If-Match | Purpose                                                     |
| -------- | ---------------------- | -------------------- | --------------- | -------- | ----------------------------------------------------------- |
| `GET`    | `/elec-phases`         | `elec-phases:read`   | —               | —        | List electrical phases (page, filters, sort)                |
| `GET`    | `/elec-phases/options` | `elec-phases:read`   | —               | —        | Id and name of every electrical phase, for a picker         |
| `GET`    | `/elec-phases/:id`     | `elec-phases:read`   | —               | —        | One electrical phase                                        |
| `POST`   | `/elec-phases`         | `elec-phases:create` | optional        | —        | Create an electrical phase                                  |
| `PUT`    | `/elec-phases/order`   | `elec-phases:update` | optional        | —        | Put the phases in a new order (all of them, in one request) |
| `PATCH`  | `/elec-phases/:id`     | `elec-phases:update` | —               | optional | Change an electrical phase                                  |
| `DELETE` | `/elec-phases/:id`     | `elec-phases:delete` | —               | optional | Delete an electrical phase                                  |

### Areas

| Method   | Path             | Access         | Idempotency-Key | If-Match | Purpose                                       |
| -------- | ---------------- | -------------- | --------------- | -------- | --------------------------------------------- |
| `GET`    | `/areas`         | `areas:read`   | —               | —        | List areas (page, filters, sort)              |
| `GET`    | `/areas/options` | `areas:read`   | —               | —        | Id, name and city of every area, for a picker |
| `GET`    | `/areas/:id`     | `areas:read`   | —               | —        | One area                                      |
| `POST`   | `/areas`         | `areas:create` | optional        | —        | Create an area                                |
| `PATCH`  | `/areas/:id`     | `areas:update` | —               | optional | Change an area                                |
| `DELETE` | `/areas/:id`     | `areas:delete` | —               | optional | Delete an area                                |

### Maintenance

| Method   | Path               | Access               | Idempotency-Key | If-Match | Purpose                                                                    |
| -------- | ------------------ | -------------------- | --------------- | -------- | -------------------------------------------------------------------------- |
| `GET`    | `/maintenance`     | `maintenance:read`   | —               | —        | List the maintenance villas (page, search, sort, `solved=true` or `false`) |
| `GET`    | `/maintenance/:id` | `maintenance:read`   | —               | —        | One maintenance villa                                                      |
| `POST`   | `/maintenance`     | `maintenance:create` | optional        | —        | Add a maintenance villa (villa number and location typed by hand)          |
| `PATCH`  | `/maintenance/:id` | `maintenance:update` | —               | optional | Change it, or check it as solved (`solved: true`) and back                 |
| `DELETE` | `/maintenance/:id` | `maintenance:delete` | —               | optional | Delete a maintenance villa                                                 |

### Materials

Deliveries from the switchgear and cable factories to the villas, each with its delivery note files (PDF, JPG or PNG; several per delivery).

| Method   | Path                                     | Access             | Idempotency-Key | If-Match | Purpose                                                                                                                              |
| -------- | ---------------------------------------- | ------------------ | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/factories`                             | `materials:read`   | —               | —        | Every factory, by type and name (`type=SWITCHGEAR` or `CABLE`)                                                                       |
| `POST`   | `/factories`                             | `materials:update` | optional        | —        | Add a factory                                                                                                                        |
| `PATCH`  | `/factories/:id`                         | `materials:update` | —               | optional | Rename a factory or change its type                                                                                                  |
| `DELETE` | `/factories/:id`                         | `materials:update` | —               | optional | Delete a factory that has no deliveries                                                                                              |
| `GET`    | `/material-items`                        | `materials:read`   | —               | —        | The catalog of materials, by type and order (`type=SWITCHGEAR` or `CABLE`)                                                           |
| `POST`   | `/material-items`                        | `materials:update` | optional        | —        | Add a material to the catalog                                                                                                        |
| `PATCH`  | `/material-items/:id`                    | `materials:update` | —               | optional | Change a catalog material (name, unit, order, required per villa)                                                                    |
| `DELETE` | `/material-items/:id`                    | `materials:update` | —               | optional | Delete a catalog material that no delivery has                                                                                       |
| `GET`    | `/material-balance`                      | `materials:read`   | —               | —        | What every villa needs against what came (page, villa, material, type, `status=PENDING`, `COMPLETE` or `OVER`)                       |
| `PUT`    | `/villas/:id/material-requirements`      | `materials:update` | —               | —        | Set a villa's own required quantities (null: back to the catalog's)                                                                  |
| `GET`    | `/material-deliveries/export`            | `materials:read`   | —               | —        | The deliveries of the list's filters, one row per material (`format=xlsx` or `pdf`)                                                  |
| `GET`    | `/material-balance/export`               | `materials:read`   | —               | —        | The balance of the list's filters (`format=xlsx` or `pdf`)                                                                           |
| `GET`    | `/material-deliveries/import/template`   | `materials:create` | —               | —        | The Excel template of the deliveries import                                                                                          |
| `POST`   | `/material-deliveries/import`            | `materials:create` | required        | —        | Import deliveries from Excel: one row per material; the rows of one delivery note become one delivery (`?dryRun=true` to check only) |
| `GET`    | `/material-deliveries`                   | `materials:read`   | —               | —        | List the deliveries (page, search, villa, factory, material (`itemId`), type, dates, `hasNote`, sort)                                |
| `GET`    | `/material-deliveries/:id`               | `materials:read`   | —               | —        | One delivery                                                                                                                         |
| `POST`   | `/material-deliveries`                   | `materials:create` | optional        | —        | Record a delivery and its materials (lines)                                                                                          |
| `PATCH`  | `/material-deliveries/:id`               | `materials:update` | —               | optional | Change a delivery                                                                                                                    |
| `DELETE` | `/material-deliveries/:id`               | `materials:delete` | —               | optional | Delete a delivery and its delivery notes                                                                                             |
| `POST`   | `/material-deliveries/:id/notes`         | `materials:update` | —               | —        | Add delivery note files (multipart, one or more files each named `file`; at most 10 per delivery)                                    |
| `GET`    | `/material-deliveries/:id/notes/:noteId` | `materials:read`   | —               | —        | One delivery note file, shown inline                                                                                                 |
| `DELETE` | `/material-deliveries/:id/notes/:noteId` | `materials:update` | —               | —        | Remove one delivery note file                                                                                                        |
| `GET`    | `/villas/:id/materials-summary`          | `materials:read`   | —               | —        | What a villa received: totals per type and material, and how many delivery notes                                                     |

### Contractors

| Method   | Path                           | Access                | Idempotency-Key | If-Match | Purpose                                                            |
| -------- | ------------------------------ | --------------------- | --------------- | -------- | ------------------------------------------------------------------ |
| `GET`    | `/contractors`                 | `contractors:read`    | —               | —        | List contractors (page, filters, sort)                             |
| `GET`    | `/contractors/options`         | `contractors:read`    | —               | —        | Id and name of every contractor, for a picker                      |
| `GET`    | `/contractors/import/template` | `contractors:import`  | —               | —        | The empty contractors import file, with an example row             |
| `POST`   | `/contractors/import`          | `contractors:import`  | required        | —        | Import contractors from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/contractors/:id/summary`     | `contractors:summary` | —               | —        | A contractor's villas (paged) and the figures of their work        |
| `GET`    | `/contractors/:id`             | `contractors:read`    | —               | —        | One contractor                                                     |
| `POST`   | `/contractors`                 | `contractors:create`  | optional        | —        | Create a contractor                                                |
| `PATCH`  | `/contractors/:id`             | `contractors:update`  | —               | optional | Change a contractor                                                |
| `DELETE` | `/contractors/:id`             | `contractors:delete`  | —               | optional | Delete a contractor                                                |

### Villas

| Method   | Path                                   | Access              | Idempotency-Key | If-Match | Purpose                                                                                                  |
| -------- | -------------------------------------- | ------------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `GET`    | `/villas`                              | `villas:read`       | —               | —        | List villas (page, filters, sort)                                                                        |
| `GET`    | `/villas/options`                      | `villas:read`       | —               | —        | Id and villa number of every villa, for a picker                                                         |
| `GET`    | `/villas/filters`                      | `villas:read`       | —               | —        | The areas and blocks the villa filters offer                                                             |
| `GET`    | `/villas/import/template`              | `villas:import`     | —               | —        | The empty villas import file, with an example row                                                        |
| `POST`   | `/villas/import`                       | `villas:import`     | required        | —        | Import villas from a spreadsheet (`?dryRun=true` only checks)                                            |
| `GET`    | `/villas/:id`                          | `villas:detail`     | —               | —        | One villa in full: its parties, its phases and their progress                                            |
| `POST`   | `/villas`                              | `villas:create`     | optional        | —        | Create a villa                                                                                           |
| `PATCH`  | `/villas/:id`                          | `villas:update`     | —               | optional | Change a villa                                                                                           |
| `POST`   | `/villas/:id/mew-follow-up`            | `villas:inspection` | optional        | optional | Put a villa on MEW follow up (409 if it already is)                                                      |
| `DELETE` | `/villas/:id/mew-follow-up`            | `villas:inspection` | optional        | optional | Take a villa off MEW follow up (409 if it is not on it)                                                  |
| `POST`   | `/villas/:id/mew-inspection`           | `villas:inspection` | optional        | optional | Put a villa on MEW inspection (409 if it already is, or its AC or electricity MEW state is not APPROVED) |
| `DELETE` | `/villas/:id/mew-inspection`           | `villas:inspection` | optional        | optional | Take a villa off MEW inspection (409 if it is not on it)                                                 |
| `POST`   | `/villas/:id/mew-inspection-passed`    | `villas:inspection` | optional        | optional | Check a villa as passed MEW inspection (409 if it already is)                                            |
| `DELETE` | `/villas/:id/mew-inspection-passed`    | `villas:inspection` | optional        | optional | Take back a passed MEW inspection (409 if it is not passed)                                              |
| `PATCH`  | `/villas/:id/mew-states`               | `villas:inspection` | —               | optional | Set the villa's MEW AC state, MEW electricity state and MEW inspection day                               |
| `DELETE` | `/villas/:id`                          | `villas:delete`     | —               | optional | Delete a villa                                                                                           |
| `PATCH`  | `/villas/:villaId/phases/:elecPhaseId` | `villas:progress`   | optional        | optional | Set the progress of one phase of one villa                                                               |

### Villa documents

| Method   | Path                            | Access                     | Idempotency-Key | If-Match | Purpose                                        |
| -------- | ------------------------------- | -------------------------- | --------------- | -------- | ---------------------------------------------- |
| `POST`   | `/villas/:villaId/documents`    | `villa-documents:upload`   | optional        | —        | Upload a PDF (multipart field `file`)          |
| `GET`    | `/villas/:villaId/documents`    | `villa-documents:download` | —               | —        | The documents of a villa                       |
| `GET`    | `/villa-documents/:id/download` | `villa-documents:download` | —               | —        | Download a document                            |
| `POST`   | `/villa-documents/:id/link`     | `villa-documents:download` | —               | —        | A signed link to view or download one document |
| `GET`    | `/villa-documents/:id/file`     | `public`                   | —               | —        | The file, for a valid signed link (`?token=`)  |
| `DELETE` | `/villa-documents/:id`          | `villa-documents:delete`   | —               | —        | Delete a document                              |

### Open works

| Method   | Path                          | Access              | Idempotency-Key | If-Match | Purpose                                                           |
| -------- | ----------------------------- | ------------------- | --------------- | -------- | ----------------------------------------------------------------- |
| `GET`    | `/open-works`                 | `open-works:read`   | —               | —        | List open works (page, filters, sort)                             |
| `GET`    | `/open-works/import/template` | `open-works:import` | —               | —        | The empty open works import file, with an example row             |
| `POST`   | `/open-works/import`          | `open-works:import` | required        | —        | Import open works from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/open-works/:id`             | `open-works:read`   | —               | —        | One open work                                                     |
| `POST`   | `/open-works`                 | `open-works:create` | optional        | —        | Create an open work                                               |
| `PATCH`  | `/open-works/:id`             | `open-works:update` | —               | optional | Change an open work                                               |
| `DELETE` | `/open-works/:id`             | `open-works:delete` | —               | optional | Delete an open work                                               |

### Daily reports

| Method   | Path                             | Access                 | Idempotency-Key | If-Match | Purpose                                                              |
| -------- | -------------------------------- | ---------------------- | --------------- | -------- | -------------------------------------------------------------------- |
| `GET`    | `/daily-reports`                 | `daily-reports:read`   | —               | —        | List daily reports (page, filters, sort)                             |
| `GET`    | `/daily-reports/import/template` | `daily-reports:import` | —               | —        | The empty daily reports import file, with an example row             |
| `POST`   | `/daily-reports/import`          | `daily-reports:import` | required        | —        | Import daily reports from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/daily-reports/:id`             | `daily-reports:read`   | —               | —        | One daily report                                                     |
| `POST`   | `/daily-reports`                 | `daily-reports:create` | optional        | —        | Create a daily report                                                |
| `PATCH`  | `/daily-reports/:id`             | `daily-reports:update` | —               | optional | Change a daily report                                                |
| `DELETE` | `/daily-reports/:id`             | `daily-reports:delete` | —               | optional | Delete a daily report                                                |

### Daily small works

| Method   | Path                           | Access               | Idempotency-Key | If-Match | Purpose                                                            |
| -------- | ------------------------------ | -------------------- | --------------- | -------- | ------------------------------------------------------------------ |
| `GET`    | `/small-works`                 | `small-works:read`   | —               | —        | List small works (page, filters, sort)                             |
| `GET`    | `/small-works/import/template` | `small-works:import` | —               | —        | The empty small works import file, with an example row             |
| `POST`   | `/small-works/import`          | `small-works:import` | required        | —        | Import small works from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/small-works/:id`             | `small-works:read`   | —               | —        | One small work                                                     |
| `POST`   | `/small-works`                 | `small-works:create` | optional        | —        | Create a small work                                                |
| `PATCH`  | `/small-works/:id`             | `small-works:update` | —               | optional | Change a small work                                                |
| `DELETE` | `/small-works/:id`             | `small-works:delete` | —               | optional | Delete a small work                                                |

### Site reports

| Method   | Path                            | Access                | Idempotency-Key | If-Match | Purpose                                                             |
| -------- | ------------------------------- | --------------------- | --------------- | -------- | ------------------------------------------------------------------- |
| `GET`    | `/site-reports`                 | `site-reports:read`   | —               | —        | List site reports (page, filters, sort)                             |
| `GET`    | `/site-reports/import/template` | `site-reports:import` | —               | —        | The empty site reports import file, with an example row             |
| `POST`   | `/site-reports/import`          | `site-reports:import` | required        | —        | Import site reports from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/site-reports/:id`             | `site-reports:read`   | —               | —        | One site report                                                     |
| `POST`   | `/site-reports`                 | `site-reports:create` | optional        | —        | Create a site report                                                |
| `PATCH`  | `/site-reports/:id`             | `site-reports:update` | —               | optional | Change a site report                                                |
| `DELETE` | `/site-reports/:id`             | `site-reports:delete` | —               | optional | Delete a site report                                                |

### Daily labour

| Method   | Path                            | Access                | Idempotency-Key | If-Match | Purpose                                                               |
| -------- | ------------------------------- | --------------------- | --------------- | -------- | --------------------------------------------------------------------- |
| `GET`    | `/daily-labour`                 | `daily-labour:read`   | —               | —        | List labour records (page, filters, sort)                             |
| `GET`    | `/daily-labour/import/template` | `daily-labour:import` | —               | —        | The empty labour records import file, with an example row             |
| `POST`   | `/daily-labour/import`          | `daily-labour:import` | required        | —        | Import labour records from a spreadsheet (`?dryRun=true` only checks) |
| `GET`    | `/daily-labour/:id`             | `daily-labour:read`   | —               | —        | One labour record                                                     |
| `POST`   | `/daily-labour`                 | `daily-labour:create` | optional        | —        | Create a labour record                                                |
| `PATCH`  | `/daily-labour/:id`             | `daily-labour:update` | —               | optional | Change a labour record                                                |
| `DELETE` | `/daily-labour/:id`             | `daily-labour:delete` | —               | optional | Delete a labour record                                                |

### Audit log

| Method | Path                  | Access       | Idempotency-Key | If-Match | Purpose                                                              |
| ------ | --------------------- | ------------ | --------------- | -------- | -------------------------------------------------------------------- |
| `GET`  | `/audit-logs`         | `audit:read` | —               | —        | List audit entries (page, filters, sort)                             |
| `GET`  | `/audit-logs/filters` | `audit:read` | —               | —        | The actions, entities and users the audit filters offer, with labels |
| `GET`  | `/audit-logs/:id`     | `audit:read` | —               | —        | One audit entry, with the before and after values                    |

### Dashboard

| Method | Path                         | Access           | Idempotency-Key | If-Match | Purpose                                                      |
| ------ | ---------------------------- | ---------------- | --------------- | -------- | ------------------------------------------------------------ |
| `GET`  | `/dashboard/summary`         | `dashboard:read` | —               | —        | The dashboard cards the caller may see (the others are null) |
| `GET`  | `/dashboard/recent-activity` | `dashboard:read` | —               | —        | The latest audit entries, for the dashboard (`limit`)        |

### Notifications

The caller's own notifications only (the small works that are due soon or overdue; see [operations.md](operations.md#small-work-deadlines-and-alerts)). There is no permission code: any signed-in user reads and marks their own. Marking read is not audited and is harmless to repeat, so neither route takes an `Idempotency-Key`.

| Method | Path                      | Access      | Idempotency-Key | If-Match | Purpose                                                                              |
| ------ | ------------------------- | ----------- | --------------- | -------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/notifications`          | `signed in` | —               | —        | My notifications, newest first (page, `unread`), with `meta.unreadCount`             |
| `POST` | `/notifications/read-all` | `signed in` | —               | —        | Mark all my notifications read; answers how many were unread                         |
| `POST` | `/notifications/:id/read` | `signed in` | —               | —        | Mark one of my notifications read (404 `NOTIFICATION_NOT_FOUND` when it is not mine) |

### Exports

| Method | Path                              | Access                      | Idempotency-Key | If-Match | Purpose                                                                                                     |
| ------ | --------------------------------- | --------------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `GET`  | `/villas/export`                  | `villas:export`             | —               | —        | The villas of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))               |
| `GET`  | `/open-works/export`              | `open-works:export`         | —               | —        | The open works of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))           |
| `GET`  | `/daily-reports/export`           | `daily-reports:export`      | —               | —        | The daily reports of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))        |
| `GET`  | `/small-works/export`             | `small-works:export`        | —               | —        | The small works of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))          |
| `GET`  | `/site-reports/export`            | `site-reports:export`       | —               | —        | The site reports of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))         |
| `GET`  | `/daily-labour/export`            | `daily-labour:export`       | —               | —        | The labour records of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))       |
| `GET`  | `/contractors/export`             | `contractors:read`          | —               | —        | The contractors of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))          |
| `GET`  | `/civil-engineers/export`         | `civil-engineers:read`      | —               | —        | The civil engineers of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))      |
| `GET`  | `/electrical-engineers/export`    | `electrical-engineers:read` | —               | —        | The electrical engineers of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md)) |
| `GET`  | `/areas/export`                   | `areas:read`                | —               | —        | The areas of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))                |
| `GET`  | `/contractors/:id/summary/export` | `contractors:summary`       | —               | —        | One contractor's summary (xlsx or pdf; see [imports-exports.md](imports-exports.md))                        |
| `GET`  | `/audit-logs/export`              | `audit:read`                | —               | —        | The audit entries of the current filters (xlsx or pdf; see [imports-exports.md](imports-exports.md))        |
