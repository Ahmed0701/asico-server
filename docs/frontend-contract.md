# Frontend contract

What a frontend needs to build against this API: the conventions every route shares, how signing in and the refresh cookie work, and then each resource's fields, filters, sorts, request bodies and error codes. The route list is in [api.md](api.md), the permissions in [permissions.md](permissions.md), every error code in [errors.md](errors.md), the spreadsheets in [imports-exports.md](imports-exports.md), and the safe-retry rules in [write-safety.md](write-safety.md).

This page is checked against the code by `tests/docs/contract.docs.test.ts`: the fields of every response type, the filters of every list, the fields of every body, the sort lists and enum values, the example shapes, the error codes of every resource and the refresh cookie are compared with the source, and a difference fails the build. Types are written as TypeScript does; `string | null` is a JSON string or `null`.

## Contents

- [Conventions](#conventions)
- [Signing in](#signing-in)
- [Users and permissions](#users-and-permissions)
- [Areas](#areas), [civil engineers](#civil-engineers), [electrical engineers](#electrical-engineers), [electrical phases](#electrical-phases), [contractors](#contractors)
- [Villas](#villas), [phase progress](#phase-progress), [documents](#villa-documents)
- [Open works](#open-works), [daily reports](#daily-reports), [daily small works](#daily-small-works), [site reports](#site-reports), [daily labour](#daily-labour)
- [Dashboard](#dashboard)
- [Audit log](#audit-log)
- [Health](#health)
- [The UTC day](#the-utc-day)

## Conventions

### Requests

| Topic          | Rule                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path      | `/api/v1`. JSON in, JSON out (`Content-Type: application/json`), except the file routes.                                                                                                                                    |
| Sign-in        | `Authorization: Bearer <accessToken>` on every route that is not `public` in [api.md](api.md).                                                                                                                              |
| Language       | `Accept-Language: ar` or `en` (default `en`). Error messages, validation messages and audit labels follow it. Exports and documents are always English.                                                                     |
| Ids            | UUIDs, as strings.                                                                                                                                                                                                          |
| Calendar days  | `YYYY-MM-DD`, meaning that day in UTC (see [The UTC day](#the-utc-day)). A filter on a day is inclusive at both ends.                                                                                                       |
| Times          | ISO 8601 instants in UTC, e.g. `2026-03-01T09:30:00.000Z`.                                                                                                                                                                  |
| Money          | A budget is an integer in the smallest unit of its currency (`budgetMinor`) with its currency code (`KWD` unless another is sent; three decimals, so `1250500` is 1,250.500 KWD). It is a JSON number, safe up to 2^53 - 1. |
| Body size      | A JSON body over the limit (100 KB unless configured) answers `413 PAYLOAD_TOO_LARGE`. An unknown field in a body is refused (400); an unknown query parameter is ignored.                                                  |
| Text           | Surrounding spaces are trimmed. A text filter is a case-insensitive "contains"; `%`, `_` and `\` in it match themselves.                                                                                                    |
| Rate limits    | A busy client gets `429 TOO_MANY_REQUESTS` with `Retry-After` and the standard `RateLimit` headers. Limits are per client IP, and for imports and exports per user ([operations.md](operations.md#rate-limits)).            |
| `X-Request-Id` | Every response carries one, and so does every error body. Quote it in a bug report.                                                                                                                                         |

### Responses

A success is `{ "data": ... }`. A list adds `meta`:

```json
{ "data": [], "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 1 } }
```

#### `PageMeta`

| Field        | Type     | Notes                                                                 |
| ------------ | -------- | --------------------------------------------------------------------- |
| `page`       | `number` | The page asked for.                                                   |
| `limit`      | `number` | The page size.                                                        |
| `total`      | `number` | Records matching the filters, over all pages.                         |
| `totalPages` | `number` | `ceil(total / limit)`, and at least 1 (an empty list is page 1 of 1). |

- A create answers `201` with the new record; a read, a change and an action answer `200` with the record; a delete answers `204` with no body.
- A single record also carries its version as an `ETag` header (`"3"`), on reads and on changes. **Use it for `If-Match` on the next change, not as a cache key.** The version moves only when that record is written, while a detail also shows what other records decide (a villa's phases and progress, a contractor's or area's `villaCount`, the names of linked records, `overdue`). So these responses are sent with `Cache-Control: private, no-store` and are never answered `304`: a request with `If-None-Match` or `If-Modified-Since` still gets `200` and the current body. Do not cache a record by its ETag or version; read it again when you need it fresh (for example, `GET /villas/:id` after changing a phase's progress shows the new phases and `progress`, while the villa's own `version` and `ETag` stay the same).
- Two routes are not wrapped: the health check (`/health`), and the file routes (an export, an import template, a download), whose body is the file.

### Errors

Every failure is the same shape; branch on `code` (and the status), never on `message`.

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Validation failed",
  "details": [{ "path": "villaNumber", "message": "Enter between 1 and 50 characters" }],
  "requestId": "0c5f2f4e-6a52-4a6b-9f3a-1c1f7b7a1d10"
}
```

#### `ErrorDetail`

| Field     | Type      | Notes                                                                                                                                      |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`    | `string`  | The field (dots for nested ones), or `version`.                                                                                            |
| `message` | `string`  | In the language of the request.                                                                                                            |
| `value`   | `unknown` | A machine-readable value for the client, when the message alone is not enough (the current version of a record that someone else changed). |

- `VALIDATION_ERROR` (400): `details` has one entry per invalid field, `path` being the field (dots for a nested one) and `message` in the language of the request. Show each message next to its field.
- `VERSION_CONFLICT` (409): `details` is `[{ "path": "version", "message": "...", "value": 4 }]`, `value` being the current version.
- `401 TOKEN_EXPIRED`: refresh the access token and repeat the request once. Any other 401: go to the sign-in page.
- `403 FORBIDDEN`: the user lacks the permission. Hide or disable the action: the permissions are on `GET /me`.
- Codes raised for any route and described once here: `UNAUTHORIZED`, `FORBIDDEN`, `BAD_REQUEST`, `NOT_FOUND` and `VALIDATION_ERROR`; the others, each with its status, are in [errors.md](errors.md). The **Errors** line under a resource lists the codes its own routes can add.

### Lists

Every list takes `page` and `limit`, plus the filters and the sort of its resource.

- `page` starts at 1 and `limit` is 1 to 1,000 (default 20). A value out of range, or not a number, answers 400: it is never clamped.
- `sort` is a field of the resource's list, `field` or `field:asc` / `field:desc`. An unknown field answers 400. Each list has a default sort, given below. Rows that tie on the sort field are ordered by id, so a page never repeats or skips a row.
- A filter that is sent and invalid answers 400; a filter that matches nothing answers an empty list, not an error.
- An export takes the same filters and sort, without `page` and `limit` ([imports-exports.md](imports-exports.md)).

### Changing safely

- **`Idempotency-Key`**: send a fresh one (a UUID) with a create or an action and repeat the request with the same key if the answer was lost; the first answer comes back, and nothing is done twice. See [write-safety.md](write-safety.md). It is **required** for the seven imports.
- **`If-Match`**: send the version you read (`"3"`) with a change or a delete. If someone else changed the record meanwhile the answer is `409 VERSION_CONFLICT` with the current version; reload and decide. Without the header the change goes through. Every record that people edit has a `version`.

## Signing in

A session is an **access token** (a JWT, 15 minutes by default, kept in memory and sent as `Authorization: Bearer`) and a **refresh token** (7 days by default, kept by the browser in an HttpOnly cookie that scripts cannot read). The access token is renewed with `POST /auth/refresh`, which needs only the cookie. The refresh token **rotates**: every refresh sets a new cookie and the old one stops working.

#### `LoginDto`

| Field         | Type      | Notes               |
| ------------- | --------- | ------------------- |
| `accessToken` | `string`  |                     |
| `expiresIn`   | `number`  |                     |
| `user`        | `UserDto` | The signed-in user. |

#### `UserDto`

| Field       | Type      | Notes                                                                          |
| ----------- | --------- | ------------------------------------------------------------------------------ |
| `id`        | `string`  | uuid                                                                           |
| `name`      | `string`  |                                                                                |
| `email`     | `string`  | The sign-in email.                                                             |
| `role`      | `Role`    | `ADMIN` or `EMPLOYEE`.                                                         |
| `isActive`  | `boolean` | false: cannot sign in.                                                         |
| `version`   | `number`  | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt` | `string`  | ISO 8601 instant, UTC.                                                         |

#### `MeDto`

| Field         | Type       | Notes                                                                          |
| ------------- | ---------- | ------------------------------------------------------------------------------ |
| `id`          | `string`   | uuid                                                                           |
| `name`        | `string`   |                                                                                |
| `email`       | `string`   | The sign-in email.                                                             |
| `role`        | `Role`     |                                                                                |
| `isActive`    | `boolean`  |                                                                                |
| `version`     | `number`   | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`   | `string`   | ISO 8601 instant, UTC.                                                         |
| `permissions` | `string[]` | Permission codes (see permissions.md). An ADMIN gets all of them.              |

#### `AccessTokenDto`

| Field         | Type     | Notes                                            |
| ------------- | -------- | ------------------------------------------------ |
| `accessToken` | `string` | Send as `Authorization: Bearer <token>`.         |
| `expiresIn`   | `number` | Seconds the access token lives (900 by default). |

### The calls

| Call                         | Body                                   | Answer                                                                                                                                                             |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/login`           | `{ "email", "password" }`              | `200` `{ data: LoginDto }` and the refresh cookie.                                                                                                                 |
| `POST /auth/refresh`         | none (the cookie)                      | `200` `{ data: AccessTokenDto }` and a new cookie.                                                                                                                 |
| `POST /auth/logout`          | none (the cookie)                      | `204`; the token is revoked and the cookie removed. Always `204`, even without a cookie.                                                                           |
| `POST /auth/signup`          | `{ "name", "email", "password" }`      | `201` `{ data: { user: UserDto, message } }`. The account is an **inactive EMPLOYEE**: it cannot sign in until an administrator activates it (`ACCOUNT_INACTIVE`). |
| `POST /auth/forgot-password` | `{ "email" }`                          | `200` `{ data: { message } }`, the same whether or not the address is registered. At most one email a minute per user.                                             |
| `POST /auth/reset-password`  | `{ "token", "password" }`              | `200` `{ data: { message } }`. Signs every session of the user out and removes the cookie.                                                                         |
| `POST /auth/change-password` | `{ "currentPassword", "newPassword" }` | `200` `{ data: { message } }`. Every other session is signed out; this one stays.                                                                                  |
| `GET /me`                    | none                                   | `200` `{ data: MeDto }`: the profile and the permission codes.                                                                                                     |
| `PATCH /me`                  | `{ "name" }`                           | `200` `{ data: UserDto }`.                                                                                                                                         |

The auth routes are limited to 10 calls per 15 minutes per client (each route has its own count), and refresh to 30 a minute ([operations.md](operations.md#rate-limits)).

**Login** `POST /auth/login`

<!-- body: loginSchema -->

| Field      | Required | Type               | Notes                         |
| ---------- | -------- | ------------------ | ----------------------------- |
| `email`    | Yes      | email, lower-cased | Any case (it is lower-cased). |
| `password` | Yes      | text               |                               |

**Sign up** `POST /auth/signup`

<!-- body: signupSchema -->

| Field      | Required | Type                      | Notes                                   |
| ---------- | -------- | ------------------------- | --------------------------------------- |
| `name`     | Yes      | text, 1 to 100 characters |                                         |
| `email`    | Yes      | email, lower-cased        | Already registered gives `EMAIL_TAKEN`. |
| `password` | Yes      | text, 8 to 72 bytes       |                                         |

**Forgot password** `POST /auth/forgot-password`

<!-- body: forgotPasswordSchema -->

| Field   | Required | Type               | Notes |
| ------- | -------- | ------------------ | ----- |
| `email` | Yes      | email, lower-cased |       |

**Reset password** `POST /auth/reset-password`

<!-- body: resetPasswordSchema -->

| Field      | Required | Type                       | Notes                          |
| ---------- | -------- | -------------------------- | ------------------------------ |
| `token`    | Yes      | text (from the email link) | The token of the emailed link. |
| `password` | Yes      | text, 8 to 72 bytes        |                                |

**Change password** `POST /auth/change-password`

<!-- body: changePasswordSchema -->

| Field             | Required | Type                | Notes |
| ----------------- | -------- | ------------------- | ----- |
| `currentPassword` | Yes      | text                |       |
| `newPassword`     | Yes      | text, 8 to 72 bytes |       |

**Change your name** `PATCH /me`

<!-- body: updateMeSchema -->

| Field  | Required | Type                      | Notes          |
| ------ | -------- | ------------------------- | -------------- |
| `name` | Yes      | text, 1 to 100 characters | Your own name. |

The `data` of a successful login:

<!-- shape: LoginDto -->

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 900,
  "user": {
    "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11",
    "name": "Mona Adel",
    "email": "mona@example.com",
    "role": "EMPLOYEE",
    "isActive": true,
    "version": 3,
    "createdAt": "2026-02-01T08:00:00.000Z"
  }
}
```

### The refresh cookie

| Attribute  | Value                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Name       | `refresh_token`                                                                                                            |
| Path       | `/api/v1/auth`: the browser sends it only to the auth routes, never to the rest of the API.                                |
| `HttpOnly` | Always. A script cannot read it.                                                                                           |
| `Secure`   | On, except when the server runs with `NODE_ENV=development` (then plain HTTP works). `REFRESH_COOKIE_SECURE` overrides it. |
| `SameSite` | `Strict` by default. `REFRESH_COOKIE_SAMESITE` sets `strict`, `lax` or `none` (`none` needs `Secure`).                     |
| `Domain`   | Not set (the cookie belongs to the API's own host) unless `REFRESH_COOKIE_DOMAIN` is.                                      |
| Expires    | With the refresh token (7 days after the last login or refresh).                                                           |

How it behaves, and what the frontend does:

- **Set** on login and on every successful refresh. **Removed** by logout and by a password reset.

**The cookie is removed after** `INVALID_REFRESH_TOKEN`, `ACCOUNT_INACTIVE`, `REFRESH_TOKEN_REUSED`: the server has judged it dead, so the browser forgets it and the user must sign in again.

- **`REFRESH_CONFLICT` (409) keeps the cookie.** Two tabs (or a retry) refreshed at the same moment and the other won. Wait a moment and call refresh again; the cookie the winner set is already in the browser. Treat it as a retry, not a logout.
- **`REFRESH_TOKEN_REUSED` signs the user out everywhere.** A token that was already spent came back (it may have been copied), so every refresh token of the user is revoked.
- **`TOKEN_EXPIRED` (401) on any other route**: call `POST /auth/refresh` once, then repeat the request with the new access token. Refresh before it expires, on a timer, to avoid the failed request.
- **Send credentials**: `fetch(url, { credentials: "include" })` (or `withCredentials` in axios) on the auth calls, or the cookie is neither sent nor stored.
- **Same site, or `SameSite=None`.** With the default `Strict` the frontend and the API must be on the same site (for example `app.example.com` and `api.example.com`; `Domain` can be left unset). On different sites, the server needs `REFRESH_COOKIE_SAMESITE=none` (and HTTPS) and `CORS_ORIGINS` listing the frontend's origin; the API answers CORS with credentials allowed.
- **The browser may read** `ETag`, `Retry-After`, `Idempotent-Replayed`, `X-Request-Id` and `Content-Disposition` on a cross-origin call (the server lists them in `Access-Control-Expose-Headers`); every other response header is visible to a script only on the same origin. `Content-Disposition` carries the file name of a download (`asico-<resource>-<date>.<format>`) and `X-Request-Id` the id to quote in a report; the error body repeats `requestId`.
- **A deactivated user** is signed out at once: the next request with the old access token answers `401 UNAUTHORIZED`, and the next refresh `403 ACCOUNT_INACTIVE`.

<!-- modules: auth -->

**Errors:** `ACCOUNT_INACTIVE`, `EMAIL_TAKEN`, `INVALID_CREDENTIALS`, `INVALID_CURRENT_PASSWORD`, `INVALID_REFRESH_TOKEN`, `INVALID_RESET_TOKEN`, `REFRESH_CONFLICT`, `REFRESH_TOKEN_REUSED`

## Users and permissions

Users are created by an administrator (or someone with `users:create`), who chooses the first password. The permissions of an EMPLOYEE are granted one by one; an ADMIN has all of them ([permissions.md](permissions.md)).

- A **list item** is a `UserDto`; one user, and the answer to a create, is a `MeDto` (it carries the permission codes). A change, an activation and a deactivation answer a `UserDto`.
- **Deactivating** a user signs them out at once and cannot be done to an ADMIN or to yourself. **Reset password** emails the user a link and signs every session out; if the email cannot be sent the answer is `502 EMAIL_DELIVERY_FAILED` (the sessions are already signed out).
- `PUT /users/:id/permissions` replaces the whole list. It cannot touch an ADMIN or the caller's own permissions.

**List** `GET /users`. Default sort: `createdAt` descending.

<!-- query: listUsersQuerySchema -->

| Parameter  | Type                                            | Notes                           |
| ---------- | ----------------------------------------------- | ------------------------------- |
| `page`     | integer, 1 or more (default 1)                  |                                 |
| `limit`    | integer, 1 to 1,000 (default 20)                |                                 |
| `sort`     | `field`, `field:asc` or `field:desc`: see Sorts |                                 |
| `role`     | `ADMIN` or `EMPLOYEE`                           |                                 |
| `isActive` | `true` or `false`                               | Active or deactivated accounts. |
| `search`   | text, up to 100 characters                      | Matches the name or the email.  |

**Sorts**

<!-- list: USER_SORT_FIELDS -->

`name`, `email`, `createdAt`, `role`

**Create** `POST /users`

<!-- body: createUserSchema -->

| Field         | Required | Type                               | Notes                                                                               |
| ------------- | -------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `name`        | Yes      | text, 1 to 100 characters          |                                                                                     |
| `email`       | Yes      | email, lower-cased                 |                                                                                     |
| `password`    | Yes      | text, 8 to 72 bytes                | The user's first password. It is never returned.                                    |
| `isActive`    | No       | `true` or `false` (default `true`) | false makes an account that cannot sign in yet.                                     |
| `permissions` | No       | array of permission codes          | Needs `permissions:assign` as well as `users:create` when not empty. Omit for none. |

**Change** `PATCH /users/:id` (`If-Match` optional)

<!-- body: updateUserSchema -->

| Field   | Required | Type                      | Notes                                     |
| ------- | -------- | ------------------------- | ----------------------------------------- |
| `name`  | No       | text, 1 to 100 characters |                                           |
| `email` | No       | email, lower-cased        | Another user's email gives `EMAIL_TAKEN`. |

**Permissions** `PUT /users/:id/permissions`

<!-- body: replacePermissionsSchema -->

| Field         | Required | Type                      | Notes                                                                            |
| ------------- | -------- | ------------------------- | -------------------------------------------------------------------------------- |
| `permissions` | Yes      | array of permission codes | The whole list replaces the old one. An ADMIN's cannot be changed, nor your own. |

#### `UserPermissionsDto`

| Field         | Type       | Notes                                        |
| ------------- | ---------- | -------------------------------------------- |
| `userId`      | `string`   |                                              |
| `permissions` | `string[]` | Permission codes granted (an EMPLOYEE only). |

#### `PermissionGroupDto`

| Field         | Type       | Notes                                           |
| ------------- | ---------- | ----------------------------------------------- |
| `resource`    | `string`   | `villas`, `open-works`, ...                     |
| `permissions` | `string[]` | The codes of that resource, e.g. `villas:read`. |

`GET /permissions` answers an array of `PermissionGroupDto`, one per resource, to build the checkbox list. Roles are `ADMIN` and `EMPLOYEE`.

<!-- modules: users, permissions -->

**Errors:** `ADMIN_ACCOUNT_PROTECTED`, `ADMIN_CANNOT_BE_DEACTIVATED`, `ADMIN_CANNOT_BE_DELETED`, `ADMIN_PERMISSIONS_IMMUTABLE`, `CANNOT_DEACTIVATE_SELF`, `CANNOT_DELETE_SELF`, `CANNOT_MODIFY_OWN_PERMISSIONS`, `EMAIL_DELIVERY_FAILED`, `EMAIL_TAKEN`, `PERMISSION_ASSIGN_REQUIRED`, `USER_HAS_RECORDS`, `USER_NOT_FOUND`

## Areas

A place villas are built in: a name within a city. Used to group and filter villas.

- `GET /areas/options` answers every area (up to 1,000), by name, as `AreaOptionDto`: for a picker.
- An area with villas cannot be deleted (`AREA_HAS_VILLAS`). Deleting is a `204`.

#### `AreaDto`

| Field        | Type     | Notes                                                                          |
| ------------ | -------- | ------------------------------------------------------------------------------ |
| `id`         | `string` | uuid                                                                           |
| `name`       | `string` |                                                                                |
| `city`       | `string` |                                                                                |
| `villaCount` | `number` | How many villas are in the area.                                               |
| `version`    | `number` | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`  | `string` | ISO 8601 instant, UTC.                                                         |
| `updatedAt`  | `string` | ISO 8601 instant, UTC.                                                         |

#### `AreaOptionDto`

| Field  | Type     | Notes |
| ------ | -------- | ----- |
| `id`   | `string` | uuid  |
| `name` | `string` |       |
| `city` | `string` |       |

**List** `GET /areas`. Default sort: `name` ascending.

<!-- query: listAreasQuerySchema -->

| Parameter | Type                                            | Notes                         |
| --------- | ----------------------------------------------- | ----------------------------- |
| `page`    | integer, 1 or more (default 1)                  |                               |
| `limit`   | integer, 1 to 1,000 (default 20)                |                               |
| `sort`    | `field`, `field:asc` or `field:desc`: see Sorts |                               |
| `search`  | text, up to 100 characters                      | Matches the name or the city. |

**Sorts**

<!-- list: AREA_SORT_FIELDS -->

`name`, `city`, `villaCount`, `createdAt`

**Create** `POST /areas`, **change** `PATCH /areas/:id` (at least one field; `If-Match` optional)

<!-- body: createAreaSchema -->

| Field  | Required | Type                      | Notes                                                            |
| ------ | -------- | ------------------------- | ---------------------------------------------------------------- |
| `name` | Yes      | text, 1 to 100 characters | Name and city together are unique, ignoring case (`AREA_TAKEN`). |
| `city` | Yes      | string, min 1, max 100    |                                                                  |

<!-- body: updateAreaSchema -->

| Field  | Required | Type                      | Notes |
| ------ | -------- | ------------------------- | ----- |
| `name` | No       | text, 1 to 100 characters |       |
| `city` | No       | string, min 1, max 100    |       |

<!-- modules: areas -->

**Errors:** `AREA_HAS_VILLAS`, `AREA_NOT_FOUND`, `AREA_TAKEN`

## Civil engineers

The engineer responsible for a villa (every villa has one). Contact details for the people who build it.

- `GET /civil-engineers/options` answers the **active** engineers only (up to 1,000), by name, as `CivilEngineerOptionDto`.
- An inactive engineer stays in the list and in the villas that already have it, but cannot be given to a villa (`CIVIL_ENGINEER_INACTIVE`).
- An engineer with villas cannot be deleted (`CIVIL_ENGINEER_HAS_VILLAS`): deactivate instead.
- `email` is optional and is not unique.

#### `CivilEngineerDto`

| Field        | Type               | Notes                                                                                         |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| `id`         | `string`           | uuid                                                                                          |
| `name`       | `string`           |                                                                                               |
| `phone`      | `string`           | As typed: 5 to 20 characters, digits, spaces and dashes, an optional leading `+`.             |
| `email`      | `string \| null`   | null when there is none.                                                                      |
| `status`     | `PartyStatusValue` | `ACTIVE` or `INACTIVE`. An inactive record stays, but cannot be given to a villa or a record. |
| `villaCount` | `number`           | How many villas use it, counted when read.                                                    |
| `version`    | `number`           | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                |
| `createdAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |
| `updatedAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |

#### `CivilEngineerOptionDto`

| Field  | Type     | Notes |
| ------ | -------- | ----- |
| `id`   | `string` | uuid  |
| `name` | `string` |       |

**List** `GET /civil-engineers`. Default sort: `name` ascending.

<!-- query: listCivilEngineersQuerySchema -->

| Parameter | Type                                            | Notes                                     |
| --------- | ----------------------------------------------- | ----------------------------------------- |
| `page`    | integer, 1 or more (default 1)                  |                                           |
| `limit`   | integer, 1 to 1,000 (default 20)                |                                           |
| `sort`    | `field`, `field:asc` or `field:desc`: see Sorts |                                           |
| `search`  | text, up to 100 characters                      | Matches the name, the phone or the email. |
| `status`  | `ACTIVE`, `INACTIVE`                            | Filter by status.                         |

**Sorts**

<!-- list: CIVIL_ENGINEER_SORT_FIELDS -->

`name`, `createdAt`

**Create** `POST /civil-engineers`, **change** `PATCH /civil-engineers/:id` (at least one field)

<!-- body: createCivilEngineerSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | Yes      | text, 1 to 100 characters                                                        |       |
| `phone`  | Yes      | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- body: updateCivilEngineerSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | No       | text, 1 to 100 characters                                                        |       |
| `phone`  | No       | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- modules: civil-engineers -->

**Errors:** `CIVIL_ENGINEER_HAS_VILLAS`, `CIVIL_ENGINEER_NOT_FOUND`

## Electrical engineers

As civil engineers, but optional on a villa.

- `GET /electrical-engineers/options` answers the **active** ones only, as `ElectricalEngineerOptionDto`.
- An inactive engineer cannot be given to a villa (`ELECTRICAL_ENGINEER_INACTIVE`); one with villas cannot be deleted (`ELECTRICAL_ENGINEER_IN_USE`).

#### `ElectricalEngineerDto`

| Field        | Type               | Notes                                                                                         |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| `id`         | `string`           | uuid                                                                                          |
| `name`       | `string`           |                                                                                               |
| `phone`      | `string`           | As typed: 5 to 20 characters, digits, spaces and dashes, an optional leading `+`.             |
| `email`      | `string \| null`   | null when there is none.                                                                      |
| `status`     | `PartyStatusValue` | `ACTIVE` or `INACTIVE`. An inactive record stays, but cannot be given to a villa or a record. |
| `villaCount` | `number`           | How many villas have this engineer.                                                           |
| `version`    | `number`           | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                |
| `createdAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |
| `updatedAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |

#### `ElectricalEngineerOptionDto`

| Field  | Type     | Notes |
| ------ | -------- | ----- |
| `id`   | `string` | uuid  |
| `name` | `string` |       |

**List** `GET /electrical-engineers`. Default sort: `name` ascending.

<!-- query: listElectricalEngineersQuerySchema -->

| Parameter | Type                                            | Notes                                     |
| --------- | ----------------------------------------------- | ----------------------------------------- |
| `page`    | integer, 1 or more (default 1)                  |                                           |
| `limit`   | integer, 1 to 1,000 (default 20)                |                                           |
| `sort`    | `field`, `field:asc` or `field:desc`: see Sorts |                                           |
| `search`  | text, up to 100 characters                      | Matches the name, the phone or the email. |
| `status`  | `ACTIVE`, `INACTIVE`                            | Filter by status.                         |

**Sorts**

<!-- list: ELECTRICAL_ENGINEER_SORT_FIELDS -->

`name`, `createdAt`

**Create** `POST /electrical-engineers`, **change** `PATCH /electrical-engineers/:id`

<!-- body: createElectricalEngineerSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | Yes      | text, 1 to 100 characters                                                        |       |
| `phone`  | Yes      | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- body: updateElectricalEngineerSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | No       | text, 1 to 100 characters                                                        |       |
| `phone`  | No       | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- modules: electrical-engineers -->

**Errors:** `ELECTRICAL_ENGINEER_IN_USE`, `ELECTRICAL_ENGINEER_NOT_FOUND`

## Electrical phases

The stages every villa's progress is tracked in (ceiling piping, box fixing, ...), in a fixed order. A villa's progress in a phase is read from its **open works**: the progress of the villa's open work filed under that phase, or 0 when it has none (the phase progress set with `PATCH /villas/:villaId/phases/:elecPhaseId` does not count). A villa's overall progress moves only when a phase is **done**: once the villa's open work for an **active** phase reaches 100, the phase adds its whole `progressRatio` (0 to 100) to the villa, and before that it adds nothing. The ratios are added up and the villa never goes past 100, so a schedule of ratios that adds up to 100 makes a villa with every phase done exactly 100.

- The list is always in `sortOrder`. There is no `sort` and no `search`.
- `GET /elec-phases/options` answers the **active** phases in order, as `ElecPhaseOptionDto`.
- `PUT /elec-phases/order` takes every phase's id once, in the new order, and answers the phases in that order (an array, no `meta`). A list that misses a phase or names one twice is `409 ELEC_PHASES_CHANGED`: reload and reorder again.
- A phase that a villa has progress in cannot be deleted (`ELEC_PHASE_IN_USE`): make it `INACTIVE` instead. The progress of an inactive phase cannot be changed (`ELEC_PHASE_INACTIVE`).
- A new phase shows at 0 in every villa; deactivating one takes it out of the averages.

#### `ElecPhaseDto`

| Field           | Type                   | Notes                                                                                                  |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`            | `string`               | uuid                                                                                                   |
| `name`          | `string`               |                                                                                                        |
| `sortOrder`     | `number`               | Position in the list, from 1.                                                                          |
| `status`        | `ElecPhaseStatusValue` | `ACTIVE` phases take part in a villa's progress; `INACTIVE` ones do not.                               |
| `progressRatio` | `number`               | 0 to 100: what the phase adds to a villa's overall progress once the villa's open work for it is done. |
| `version`       | `number`               | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                         |
| `createdAt`     | `string`               | ISO 8601 instant, UTC.                                                                                 |
| `updatedAt`     | `string`               | ISO 8601 instant, UTC.                                                                                 |

#### `ElecPhaseOptionDto`

| Field  | Type     | Notes |
| ------ | -------- | ----- |
| `id`   | `string` | uuid  |
| `name` | `string` |       |

**Statuses**

<!-- list: ELEC_PHASE_STATUSES -->

`ACTIVE`, `INACTIVE`

**List** `GET /elec-phases`

<!-- query: listElecPhasesQuerySchema -->

| Parameter | Type                             | Notes             |
| --------- | -------------------------------- | ----------------- |
| `page`    | integer, 1 or more (default 1)   |                   |
| `limit`   | integer, 1 to 1,000 (default 20) |                   |
| `status`  | `ACTIVE`, `INACTIVE`             | Filter by status. |

**Create** `POST /elec-phases`, **change** `PATCH /elec-phases/:id`, **reorder** `PUT /elec-phases/order`

<!-- body: createElecPhaseSchema -->

| Field           | Required | Type                      | Notes                                                               |
| --------------- | -------- | ------------------------- | ------------------------------------------------------------------- |
| `name`          | Yes      | text, 1 to 100 characters | Unique, ignoring case (`ELEC_PHASE_NAME_TAKEN`).                    |
| `status`        | No       | `ACTIVE` or `INACTIVE`    | Default `ACTIVE`.                                                   |
| `progressRatio` | No       | integer, 0 to 100         | Default 0. How much the phase counts in a villa's overall progress. |

<!-- body: updateElecPhaseSchema -->

| Field           | Required | Type                      | Notes |
| --------------- | -------- | ------------------------- | ----- |
| `name`          | No       | text, 1 to 100 characters |       |
| `status`        | No       | `ACTIVE` or `INACTIVE`    |       |
| `progressRatio` | No       | integer, 0 to 100         |       |

<!-- body: reorderElecPhasesSchema -->

| Field | Required | Type                                               | Notes                                                           |
| ----- | -------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `ids` | Yes      | array of uuid: every phase, once, in the new order | Must name every phase exactly once, else `ELEC_PHASES_CHANGED`. |

<!-- modules: elec-phases -->

**Errors:** `ELEC_PHASES_CHANGED`, `ELEC_PHASE_IN_USE`, `ELEC_PHASE_NAME_TAKEN`, `ELEC_PHASE_NOT_FOUND`

## Contractors

The firms that build villas. A villa has at most one contractor, and the records written for a villa name only that contractor.

- `GET /contractors/options` answers the **active** contractors only (up to 1,000), as `ContractorOptionDto`.
- An inactive contractor cannot be given to a villa or a record (`CONTRACTOR_INACTIVE`). One linked to villas or records cannot be deleted (`CONTRACTOR_HAS_VILLAS`).
- `GET /contractors/:id/summary` answers the contractor, the figures of their work in the other resources and one page of their villas (`ContractorSummaryDto` and `meta`, with `page`, `limit` and `sort` below); `GET /contractors/:id/summary/export` is its spreadsheet or PDF. Each figures section needs the read permission of its resource and is `null` without it: see the table below. Hide a `null` section; do not show it as zero.
- The contractors can be imported from a spreadsheet ([imports-exports.md](imports-exports.md)).
- **Every import answers the same report**, `{ ok, total, imported, skipped, errors, truncated }`: `skipped` counts the rows left out on purpose (only the open works import skips, the automatic items of an exported file) and is `0` everywhere else. A file that was exported can be imported again as it is, on another environment; it is not an update in place ([imports-exports.md](imports-exports.md#exporting-and-importing-again)).
- **Templates contain dropdowns; the server still validates.** `GET /<resource>/import/template` (same URL and permission) is built when it is downloaded and has dropdowns on the columns that name a record (area, engineer, contractor, villa number) or take a fixed list (status, phase, priority, weather, type, rating, currency), from a hidden last sheet `Lists` that the import never reads. Do not rely on them: every row is checked on upload, and a pasted value is a row error as before. The choices are the texts the import resolves to exactly one record (the villas export's text: the name, `Name, City` or the phone when a name is shared), for active records only, so show the template as built for the moment of download; fetch it again, do not cache it. The columns, the Instructions sheet and the header are unchanged. Anyone with `<resource>:import` sees those names, the phone of a party whose name is shared, and every villa number in the file ([imports-exports.md](imports-exports.md#dropdowns-in-the-template)).

#### `ContractorDto`

| Field        | Type               | Notes                                                                                         |
| ------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| `id`         | `string`           | uuid                                                                                          |
| `name`       | `string`           |                                                                                               |
| `phone`      | `string`           | As typed: 5 to 20 characters, digits, spaces and dashes, an optional leading `+`.             |
| `email`      | `string \| null`   | null when there is none.                                                                      |
| `status`     | `PartyStatusValue` | `ACTIVE` or `INACTIVE`. An inactive record stays, but cannot be given to a villa or a record. |
| `villaCount` | `number`           | How many villas use it, counted when read.                                                    |
| `version`    | `number`           | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                |
| `createdAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |
| `updatedAt`  | `string`           | ISO 8601 instant, UTC.                                                                        |

#### `ContractorOptionDto`

| Field  | Type     | Notes |
| ------ | -------- | ----- |
| `id`   | `string` | uuid  |
| `name` | `string` |       |

#### `ContractorVillaDto`

| Field         | Type             | Notes            |
| ------------- | ---------------- | ---------------- |
| `id`          | `string`         | uuid             |
| `villaNumber` | `string`         |                  |
| `area`        | `string`         | The area's name. |
| `block`       | `string`         |                  |
| `plot`        | `string`         |                  |
| `startDate`   | `string \| null` |                  |
| `targetDate`  | `string \| null` |                  |

#### `ContractorSummaryDto`

| Field          | Type                                                                                                                                                 | Notes                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contractor`   | `{ id: string; name: string; phone: string }`                                                                                                        | The contractor.                                                                                                                                                                                                                      |
| `villaCount`   | `number`                                                                                                                                             | All the contractor's villas, not just this page.                                                                                                                                                                                     |
| `openWorks`    | `{ total: number; byStatus: { NOT_STARTED: number; IN_PROGRESS: number; DELAYED: number; DONE: number }; delayed: number; overdue: number } \| null` | The open works that name this contractor, on any villa (open-works:read). `total` is the sum of `byStatus`; `delayed` is `byStatus.DELAYED`; `overdue` is the open works list's own rule (end date before today, UTC, and not done). |
| `smallWorks`   | `{ total: number; pending: number; done: number; overdue: number; dueSoon: number } \| null`                                                         | The small works of this contractor (small-works:read). `overdue` and `dueSoon` are the small works' deadline rules, in the application time zone, and count pending works only.                                                      |
| `dailyReports` | `{ count: number; lastReportDate: string \| null } \| null`                                                                                          | The daily reports of this contractor (daily-reports:read): how many, and the latest report date (`YYYY-MM-DD`, null with none).                                                                                                      |
| `labour`       | `{ entries: number; totalLabour: number; lastLabourDate: string \| null } \| null`                                                                   | The daily labour rows of this contractor (daily-labour:read): how many rows, the labourers added up over them, and the latest labour date (null with none).                                                                          |
| `villas`       | `ContractorVillaDto[]`                                                                                                                               | One page of the contractor's villas.                                                                                                                                                                                                 |

Every number counts the rows that **name the contractor** (a daily report, a small work and a labour row each carry the contractor; an open work carries it when one was chosen), whatever the villa. A contractor with no work of a kind has zeros and a `null` date, not a `null` section. The administrator sees all four sections; an employee sees the ones whose read permission they hold. `contractors:summary` alone shows the contractor and the villas only.

**List** `GET /contractors`. Default sort: `name` ascending.

<!-- query: listContractorsQuerySchema -->

| Parameter | Type                                            | Notes                                     |
| --------- | ----------------------------------------------- | ----------------------------------------- |
| `page`    | integer, 1 or more (default 1)                  |                                           |
| `limit`   | integer, 1 to 1,000 (default 20)                |                                           |
| `sort`    | `field`, `field:asc` or `field:desc`: see Sorts |                                           |
| `search`  | text, up to 100 characters                      | Matches the name, the phone or the email. |
| `status`  | `ACTIVE`, `INACTIVE`                            | Filter by status.                         |

**Sorts**

<!-- list: CONTRACTOR_SORT_FIELDS -->

`name`, `createdAt`

**Summary** `GET /contractors/:id/summary`. Default sort: `villaNumber` ascending.

<!-- query: contractorSummaryQuerySchema -->

| Parameter | Type                                            | Notes |
| --------- | ----------------------------------------------- | ----- |
| `page`    | integer, 1 or more (default 1)                  |       |
| `limit`   | integer, 1 to 1,000 (default 20)                |       |
| `sort`    | `field`, `field:asc` or `field:desc`: see Sorts |       |

**Summary sorts**

<!-- list: SUMMARY_SORT_FIELDS -->

`villaNumber`, `startDate`, `targetDate`

**Create** `POST /contractors`, **change** `PATCH /contractors/:id`

<!-- body: createContractorSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | Yes      | text, 1 to 100 characters                                                        |       |
| `phone`  | Yes      | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- body: updateContractorSchema -->

| Field    | Required | Type                                                                             | Notes |
| -------- | -------- | -------------------------------------------------------------------------------- | ----- |
| `name`   | No       | text, 1 to 100 characters                                                        |       |
| `phone`  | No       | text, 5 to 20 characters: digits, spaces, dashes, a leading `+`                  |       |
| `email`  | No       | email, lower-cased (a party's is optional: `null` or empty for none; not unique) |       |
| `status` | No       | `ACTIVE` or `INACTIVE`                                                           |       |

<!-- modules: contractors -->

**Errors:** `CONTRACTOR_HAS_VILLAS`, `CONTRACTOR_NOT_FOUND`, `NO_FILE_PROVIDED`

## Villas

The centre of the system: everything else (open works, reports, labour, progress, documents) belongs to a villa.

- A villa has an **area, block and plot** (together unique), a **number** (unique), a civil engineer, optionally an electrical engineer, a contractor, an owner, dates and a budget.
- **Progress is derived, never stored.** `progress` is what the villa's done active phases add up to: each phase whose open work on the villa is at 100 adds its `progressRatio`, at most 100 in all. It is set phase by phase ([phase progress](#phase-progress)).
- A villa cannot be deleted while it has open works added by hand, small works, site reports or labour (`VILLA_HAS_RECORDS`): delete those first. (Daily reports do not belong to a villa and never block its deletion.) Its phase progress, its automatic open works and the records of its documents go with it.
- `GET /villas/options` answers every villa (up to 1,000) as `VillaOptionDto`, by number, for a picker. `GET /villas/filters` answers the area names, the blocks and the engineers the filters offer.
- One villa (`GET /villas/:id`) is the **detail** (`VillaDetailDto`): it adds the parties' phone numbers, who created it, and the phases with their progress. It needs `villas:detail`, not `villas:read` ([permissions.md](permissions.md)).
- **Villas can be loaded from a spreadsheet** with `villas:import`: `GET /villas/import/template` gives the file and `POST /villas/import` (multipart field `file`, `Idempotency-Key` required, `?dryRun=true` to only check) saves it. The columns are, exactly and in any order, `Villa Number`, `Owner Name`, `Area`, `Block`, `Plot`, `Contractor`, `Electrical Engineer`, `Civil Engineer`, `Start Date`, `Target Date`, `Budget` and `Currency` (the one a file may leave out: without it every budget is in KWD); the villa number, area, block, plot and civil engineer are required. They are the columns of the villas export, so an exported file imports as it is: its `Progress`, `Ready`, `Ready Date` and `Created (UTC)` columns are allowed and ignored. A file is saved whole or not at all, up to 2,000 villas, each as a villa created by hand would be: the same progress rows (one per phase) and the same audit entry. The columns, what each takes and the row errors are in [imports-exports.md](imports-exports.md#villas): numbers typed into the villa number, block, plot or owner are read as text, an area, a contractor or an engineer is found by name (an engineer or contractor also by phone) and never created or guessed, and the budget is in the currency of the `Currency` column (`1234.567` in `KWD`, the default, `1250000.50` in `EGP` or `USD`), saved as `budgetMinor` with that `currency`.

#### `VillaListItemDto`

| Field                 | Type                     | Notes                                                                                                                                                                                               |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `string`                 | uuid                                                                                                                                                                                                |
| `villaNumber`         | `string`                 |                                                                                                                                                                                                     |
| `ownerName`           | `string \| null`         |                                                                                                                                                                                                     |
| `villaType`           | `VillaTypeValue \| null` | How the villa is built: `ACICO_SYSTEM` or `CONVENTIONAL`. null when it has not been set.                                                                                                            |
| `area`                | `string`                 | The area's name, with its id beside it.                                                                                                                                                             |
| `areaId`              | `string`                 | The area's id.                                                                                                                                                                                      |
| `block`               | `string`                 |                                                                                                                                                                                                     |
| `plot`                | `string`                 |                                                                                                                                                                                                     |
| `location`            | `string`                 | "<area> . <block> . <plot>", as the list shows and sorts it.                                                                                                                                        |
| `civilEngineer`       | `Party`                  | `{ id, name }`.                                                                                                                                                                                     |
| `electricalEngineer`  | `Party \| null`          | `{ id, name }`, or null.                                                                                                                                                                            |
| `contractor`          | `Party \| null`          | `{ id, name }`, or null while none is set.                                                                                                                                                          |
| `startDate`           | `string \| null`         | Calendar days, YYYY-MM-DD.                                                                                                                                                                          |
| `targetDate`          | `string \| null`         |                                                                                                                                                                                                     |
| `budgetMinor`         | `number \| null`         | The budget in minor units (an integer) with its ISO 4217 currency; both null when there is no budget.                                                                                               |
| `currency`            | `string \| null`         |                                                                                                                                                                                                     |
| `progress`            | `number`                 | Overall progress, 0 to 100: the progress ratios of the active phases whose open work on the villa is done (100) added up, never more than 100 (0 when none is done). Derived on read, never stored. |
| `mewFollowUp`         | `VillaMarkDto \| null`   | Set only by a person (POST /villas/:id/mew-follow-up). null: not on the MEW follow-up list.                                                                                                         |
| `mewInspection`       | `VillaMarkDto \| null`   | Set only by a person (POST /villas/:id/mew-inspection). null: not on the MEW inspection list.                                                                                                       |
| `mewInspectionPassed` | `VillaMarkDto \| null`   | Set only by a person (POST /villas/:id/mew-inspection-passed). null: has not passed the MEW inspection.                                                                                             |
| `mewAcState`          | `MewStateValue`          | Where the villa's file stands with MEW: NOT_SUBMITTED, RUNNING or APPROVED (PATCH /villas/:id/mew-states).                                                                                          |
| `mewElecState`        | `MewStateValue`          |                                                                                                                                                                                                     |
| `mewInspectionDate`   | `string \| null`         | The day MEW is to inspect the villa, YYYY-MM-DD; null until it is picked (PATCH /villas/:id/mew-states).                                                                                            |
| `version`             | `number`                 | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                                                                                                                      |
| `createdAt`           | `string`                 | ISO 8601 instant, UTC.                                                                                                                                                                              |
| `updatedAt`           | `string`                 | ISO 8601 instant, UTC.                                                                                                                                                                              |

#### `VillaDetailDto`

| Field                 | Type                                  | Notes                                                                                                                                                                                               |
| --------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `string`                              | uuid                                                                                                                                                                                                |
| `villaNumber`         | `string`                              |                                                                                                                                                                                                     |
| `ownerName`           | `string \| null`                      |                                                                                                                                                                                                     |
| `villaType`           | `VillaTypeValue \| null`              | `ACICO_SYSTEM` or `CONVENTIONAL`, or null.                                                                                                                                                          |
| `area`                | `string`                              | The area's name, with its id beside it.                                                                                                                                                             |
| `areaId`              | `string`                              |                                                                                                                                                                                                     |
| `block`               | `string`                              |                                                                                                                                                                                                     |
| `plot`                | `string`                              |                                                                                                                                                                                                     |
| `location`            | `string`                              | "<area> . <block> . <plot>", as the list shows and sorts it.                                                                                                                                        |
| `startDate`           | `string \| null`                      | Calendar days, YYYY-MM-DD.                                                                                                                                                                          |
| `targetDate`          | `string \| null`                      |                                                                                                                                                                                                     |
| `budgetMinor`         | `number \| null`                      | The budget in minor units (an integer) with its ISO 4217 currency; both null when there is no budget.                                                                                               |
| `currency`            | `string \| null`                      |                                                                                                                                                                                                     |
| `progress`            | `number`                              | Overall progress, 0 to 100: the progress ratios of the active phases whose open work on the villa is done (100) added up, never more than 100 (0 when none is done). Derived on read, never stored. |
| `mewFollowUp`         | `VillaMarkDto \| null`                | Set only by a person (POST /villas/:id/mew-follow-up). null: not on the MEW follow-up list.                                                                                                         |
| `mewInspection`       | `VillaMarkDto \| null`                | Set only by a person (POST /villas/:id/mew-inspection). null: not on the MEW inspection list.                                                                                                       |
| `mewInspectionPassed` | `VillaMarkDto \| null`                | Set only by a person (POST /villas/:id/mew-inspection-passed). null: has not passed the MEW inspection.                                                                                             |
| `mewAcState`          | `MewStateValue`                       | Where the villa's file stands with MEW: NOT_SUBMITTED, RUNNING or APPROVED (PATCH /villas/:id/mew-states).                                                                                          |
| `mewElecState`        | `MewStateValue`                       |                                                                                                                                                                                                     |
| `mewInspectionDate`   | `string \| null`                      | The day MEW is to inspect the villa, YYYY-MM-DD; null until it is picked (PATCH /villas/:id/mew-states).                                                                                            |
| `version`             | `number`                              | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                                                                                                                      |
| `createdAt`           | `string`                              | ISO 8601 instant, UTC.                                                                                                                                                                              |
| `updatedAt`           | `string`                              | ISO 8601 instant, UTC.                                                                                                                                                                              |
| `civilEngineer`       | `Party & { phone: string }`           | `{ id, name, phone }`.                                                                                                                                                                              |
| `electricalEngineer`  | `(Party & { phone: string }) \| null` | `{ id, name, phone }`, or null.                                                                                                                                                                     |
| `contractor`          | `(Party & { phone: string }) \| null` | `{ id, name, phone }`, or null.                                                                                                                                                                     |
| `createdBy`           | `{ id: string; name: string }`        | `{ id, name }`.                                                                                                                                                                                     |
| `phaseCount`          | `number`                              | How many active phases the progress is averaged over.                                                                                                                                               |
| `phases`              | `PhaseProgressDto[]`                  | The active phases, in display order, each with the villa's progress in it.                                                                                                                          |

#### `VillaMarkDto`

| Field | Type            | Notes                                            |
| ----- | --------------- | ------------------------------------------------ |
| `at`  | `string`        | ISO 8601 instant when the mark was put on.       |
| `by`  | `Party \| null` | Who marked it, or null if that user was deleted. |

#### `VillaOptionDto`

| Field         | Type     | Notes |
| ------------- | -------- | ----- |
| `id`          | `string` | uuid  |
| `villaNumber` | `string` |       |

#### `VillaFiltersDto`

| Field                 | Type       | Notes                                                                     |
| --------------------- | ---------- | ------------------------------------------------------------------------- |
| `areas`               | `string[]` | The distinct area names.                                                  |
| `blocks`              | `string[]` | The distinct blocks.                                                      |
| `civilEngineers`      | `Party[]`  | The civil engineers with at least one villa, active or not, by name.      |
| `electricalEngineers` | `Party[]`  | The electrical engineers with at least one villa, active or not, by name. |

A villa as the list shows it (the `data` of one item):

<!-- shape: VillaListItemDto -->

```json
{
  "id": "3b0f6c1e-8a46-4f0e-9a37-0c7c2f6d51aa",
  "villaNumber": "V-014",
  "ownerName": "Karim Fawzy",
  "villaType": "ACICO_SYSTEM",
  "area": "New Cairo",
  "areaId": "9d1a52f0-2b7e-4d6a-8c1f-5b3e7a90c412",
  "block": "B2",
  "plot": "14",
  "location": "New Cairo . B2 . 14",
  "civilEngineer": { "id": "c1c0b0a0-1111-4a2b-8c3d-4e5f60718293", "name": "Eng. Mona Adel" },
  "electricalEngineer": { "id": "d2d1c1b1-2222-4b3c-9d4e-5f6071829304", "name": "Eng. Hamdy Salah" },
  "contractor": { "id": "e3e2d2c2-3333-4c4d-8e5f-607182930415", "name": "Nile Contracting" },
  "startDate": "2026-01-15",
  "targetDate": "2026-09-30",
  "budgetMinor": 1250500,
  "currency": "KWD",
  "progress": 42.5,
  "mewFollowUp": {
    "at": "2026-03-05T11:00:00.000Z",
    "by": { "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11", "name": "Mona Adel" }
  },
  "mewInspection": {
    "at": "2026-03-06T09:00:00.000Z",
    "by": { "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11", "name": "Mona Adel" }
  },
  "mewInspectionPassed": {
    "at": "2026-03-07T10:00:00.000Z",
    "by": { "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11", "name": "Mona Adel" }
  },
  "mewAcState": "RUNNING",
  "mewElecState": "NOT_SUBMITTED",
  "mewInspectionDate": "2026-12-01",
  "version": 3,
  "createdAt": "2026-01-10T08:00:00.000Z",
  "updatedAt": "2026-03-01T09:30:00.000Z"
}
```

In this example `1250500` is 1,250.500 KWD: the dinar has three decimals, so `budgetMinor` counts fils, 1,000 to the dinar.

**List** `GET /villas`. Default sort: `location` ascending. Villas without a target date come last when sorting by it.

<!-- query: listVillasQuerySchema -->

| Parameter              | Type                                            | Notes                                                                                                                                    |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                 | integer, 1 or more (default 1)                  |                                                                                                                                          |
| `limit`                | integer, 1 to 1,000 (default 20)                |                                                                                                                                          |
| `sort`                 | `field`, `field:asc` or `field:desc`: see Sorts |                                                                                                                                          |
| `area`                 | text, up to 50 characters                       | An area's name (any case) or its id. `areaId` is the exact form.                                                                         |
| `areaId`               | uuid                                            |                                                                                                                                          |
| `block`                | text, up to 50 characters                       |                                                                                                                                          |
| `plot`                 | text, up to 50 characters                       |                                                                                                                                          |
| `civilEngineerId`      | uuid                                            |                                                                                                                                          |
| `electricalEngineerId` | uuid                                            |                                                                                                                                          |
| `contractorId`         | uuid                                            |                                                                                                                                          |
| `mewFollowUp`          | `true` or `false`                               | `true`: on the MEW follow-up list. `false`: not on it.                                                                                   |
| `mewInspection`        | `true` or `false`                               | `true`: on the MEW inspection list. `false`: not on it.                                                                                  |
| `mewInspectionPassed`  | `true` or `false`                               | `true`: passed the MEW inspection. `false`: not passed. The MEW inspection page asks for `mewInspection=true&mewInspectionPassed=false`. |
| `villaType`            | `ACICO_SYSTEM` or `CONVENTIONAL`                | Only villas of this type.                                                                                                                |
| `startFrom`            | date `YYYY-MM-DD`                               | Villas whose start date is on or after this day.                                                                                         |
| `startTo`              | date `YYYY-MM-DD`                               | On or before this day.                                                                                                                   |
| `targetFrom`           | date `YYYY-MM-DD`                               | Villas whose target date is on or after this day.                                                                                        |
| `targetTo`             | date `YYYY-MM-DD`                               | On or before this day.                                                                                                                   |
| `search`               | text, up to 100 characters                      | Matches the villa number, the owner, or the name of the civil or the electrical engineer.                                                |

**Sorts**

<!-- list: VILLA_SORT_FIELDS -->

`location`, `targetDate`, `villaNumber`, `progress`, `createdAt`

**Create** `POST /villas`, **change** `PATCH /villas/:id` (at least one field; `If-Match` optional)

<!-- body: createVillaSchema -->

| Field                  | Required | Type                                                                               | Notes                                                                                                                              |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `villaNumber`          | Yes      | string, min 1, max 50                                                              | Unique (`VILLA_NUMBER_TAKEN`).                                                                                                     |
| `ownerName`            | No       | text, 1 to 120 characters, or `null`                                               |                                                                                                                                    |
| `villaType`            | No       | `ACICO_SYSTEM` or `CONVENTIONAL`, or `null`                                        | How the villa is built. Missing or null: not set.                                                                                  |
| `areaId`               | Yes      | uuid                                                                               |                                                                                                                                    |
| `block`                | Yes      | string, min 1, max 50                                                              |                                                                                                                                    |
| `plot`                 | Yes      | string, min 1, max 50                                                              | Area, block and plot together are unique (`VILLA_PLOT_TAKEN`).                                                                     |
| `civilEngineerId`      | Yes      | uuid                                                                               | Must be an active civil engineer.                                                                                                  |
| `electricalEngineerId` | No       | uuid, or `null`                                                                    | Must be an active electrical engineer.                                                                                             |
| `contractorId`         | No       | uuid, or `null`                                                                    | Must be an active contractor.                                                                                                      |
| `startDate`            | No       | date `YYYY-MM-DD`, or `null`                                                       |                                                                                                                                    |
| `targetDate`           | No       | date `YYYY-MM-DD`, or `null`                                                       | Not before the start date.                                                                                                         |
| `budgetMinor`          | No       | integer 0 to 9,007,199,254,740,991 (minor units), or `null`                        | The budget in minor units (fils for KWD, piastres for EGP, cents for USD). `budgetMinor` and `currency` are both set or both null. |
| `currency`             | No       | ISO 4217 code, 3 capital letters (default `KWD` when a budget is sent without one) |                                                                                                                                    |

<!-- body: updateVillaSchema -->

| Field                  | Required | Type                                                                               | Notes                                       |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `villaNumber`          | No       | string, min 1, max 50                                                              |                                             |
| `ownerName`            | No       | text, 1 to 120 characters, or `null`                                               |                                             |
| `villaType`            | No       | `ACICO_SYSTEM` or `CONVENTIONAL`, or `null`                                        |                                             |
| `areaId`               | No       | uuid                                                                               |                                             |
| `block`                | No       | string, min 1, max 50                                                              |                                             |
| `plot`                 | No       | string, min 1, max 50                                                              |                                             |
| `civilEngineerId`      | No       | uuid                                                                               |                                             |
| `electricalEngineerId` | No       | uuid, or `null`                                                                    |                                             |
| `contractorId`         | No       | uuid, or `null`                                                                    | The villa's own contractor; must be active. |
| `startDate`            | No       | date `YYYY-MM-DD`, or `null`                                                       |                                             |
| `targetDate`           | No       | date `YYYY-MM-DD`, or `null`                                                       |                                             |
| `budgetMinor`          | No       | integer 0 to 9,007,199,254,740,991 (minor units), or `null`                        |                                             |
| `currency`             | No       | ISO 4217 code, 3 capital letters (default `KWD` when a budget is sent without one) |                                             |

<!-- modules: villas -->

**Errors:** `AREA_NOT_FOUND`, `CIVIL_ENGINEER_INACTIVE`, `CIVIL_ENGINEER_NOT_FOUND`, `CONTRACTOR_INACTIVE`, `CONTRACTOR_NOT_FOUND`, `ELECTRICAL_ENGINEER_INACTIVE`, `ELECTRICAL_ENGINEER_NOT_FOUND`, `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`, `VILLA_ALREADY_MEW_FOLLOW_UP`, `VILLA_ALREADY_MEW_INSPECTION`, `VILLA_ALREADY_MEW_INSPECTION_PASSED`, `VILLA_HAS_RECORDS`, `VILLA_NOT_FOUND`, `VILLA_NOT_MEW_FOLLOW_UP`, `VILLA_NOT_MEW_INSPECTION`, `VILLA_NOT_MEW_INSPECTION_PASSED`, `VILLA_NUMBER_TAKEN`, `VILLA_PLOT_TAKEN`

### Phase progress

How far a villa has got in one electrical phase. `PATCH /villas/:villaId/phases/:elecPhaseId` sets it and answers the new state with the villa's overall progress.

- The row has its **own** version: `If-Match` carries `PhaseProgressDto.version` (from the villa detail's `phases`), not the villa's version.
- A phase at 100 is done (`state: DONE`); moving it back below 100 reopens it. A change above 0 creates (and later keeps in step) the automatic open work of that villa and phase (`source: PHASE`), see [open works](#open-works).
- The progress of an inactive phase cannot be changed (`ELEC_PHASE_INACTIVE`). It needs `villas:progress`.

#### `PhaseProgressDto`

| Field         | Type            | Notes                                                                |
| ------------- | --------------- | -------------------------------------------------------------------- |
| `elecPhaseId` | `string`        | The electrical phase.                                                |
| `name`        | `string`        | The phase's name.                                                    |
| `order`       | `number`        | The phase's place in the list (its sortOrder).                       |
| `progress`    | `number`        | 0 to 100.                                                            |
| `state`       | `ProgressState` | `NOT_STARTED` at 0, `DONE` at 100, `IN_PROGRESS` between.            |
| `version`     | `number`        | The version of the progress row: what the update's If-Match carries. |

#### `PhaseProgressUpdateDto`

| Field           | Type            | Notes                                                                  |
| --------------- | --------------- | ---------------------------------------------------------------------- |
| `elecPhaseId`   | `string`        | The electrical phase.                                                  |
| `name`          | `string`        | The phase's name.                                                      |
| `order`         | `number`        | The phase's place in the list (its sortOrder).                         |
| `progress`      | `number`        | 0 to 100.                                                              |
| `state`         | `ProgressState` | `NOT_STARTED` at 0, `DONE` at 100, `IN_PROGRESS` between.              |
| `version`       | `number`        | The version of the progress row: what the update's If-Match carries.   |
| `villaProgress` | `number`        | The villa's overall progress after the change (0 to 100, one decimal). |
| `phaseCount`    | `number`        | How many active phases it is averaged over.                            |

**States**

<!-- list: PROGRESS_STATES -->

`NOT_STARTED`, `IN_PROGRESS`, `DONE`

**Set** `PATCH /villas/:villaId/phases/:elecPhaseId`

<!-- body: updatePhaseProgressSchema -->

| Field      | Required | Type              | Notes                                                                |
| ---------- | -------- | ----------------- | -------------------------------------------------------------------- |
| `progress` | Yes      | integer, 0 to 100 | A move to 100 marks the phase done; a move away from 100 reopens it. |

<!-- modules: villa-progress -->

**Errors:** `ELEC_PHASE_INACTIVE`, `ELEC_PHASE_NOT_FOUND`, `VILLA_NOT_FOUND`

### Villa documents

PDF files attached to a villa (a contract, a permit). `POST /villas/:villaId/documents` takes `multipart/form-data` with one file in the field `file`; `GET /villas/:villaId/documents` answers an array of `VillaDocumentDto` (no `meta`); `GET /villa-documents/:id/download` answers the PDF as an attachment; `DELETE /villa-documents/:id` answers `204`.

- Only PDF is accepted, decided by the file's first bytes, not its name or its declared type (`INVALID_FILE_TYPE`).
- At most 25 MB a file (`FILE_TOO_LARGE`, 413) and 10 documents per villa (`VILLA_DOCUMENT_LIMIT`), unless the server is configured otherwise ([operations.md](operations.md#environment)).
- Only one file per request (`TOO_MANY_FILES`), and a request with none is `NO_FILE_PROVIDED`.

#### `VillaDocumentDto`

| Field          | Type                           | Notes                               |
| -------------- | ------------------------------ | ----------------------------------- |
| `id`           | `string`                       | uuid                                |
| `villaId`      | `string`                       | The villa it belongs to.            |
| `originalName` | `string`                       | The file's name as it was uploaded. |
| `sizeBytes`    | `number`                       | Size of the PDF in bytes.           |
| `mimeType`     | `string`                       | `application/pdf`.                  |
| `uploadedBy`   | `{ id: string; name: string }` | `{ id, name }`.                     |
| `createdAt`    | `string`                       | ISO 8601 instant, UTC.              |

<!-- modules: villa-documents -->

**Errors:** `FILE_LINK_INVALID`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `NO_FILE_PROVIDED`, `TOO_MANY_FILES`, `VILLA_DOCUMENT_LIMIT`, `VILLA_NOT_FOUND`

## Records of a villa

Open works, small works, site reports and daily labour are written **for a villa**: the body carries `villaId`, the list filters by `villaId`, and each row shows `villa: { id, villaNumber, location }`. The villa cannot be changed afterwards (it is not in the change body); delete the record and make a new one. A list item and the single record are the same shape. Each of the four can be exported and imported ([imports-exports.md](imports-exports.md)).

**Daily reports are not records of a villa.** A daily report belongs to a **contractor** and to the **electrical engineer** who prepared it ([Daily reports](#daily-reports)): it has no `villaId` in its body, no `villa` in its answer, and the list refuses the old `villaId` filter. See [the villa's daily reports tab](#the-villa-detail-daily-reports-tab) for what the villa page does instead.

Where an open work or a labour row names a **contractor**, it must be the villa's own contractor, and active: another contractor answers `422 CONTRACTOR_NOT_ON_VILLA`, an inactive one `400 CONTRACTOR_INACTIVE`, and a contractor that does not exist `404 CONTRACTOR_NOT_FOUND`. (A small work takes any active contractor; a daily report takes any active contractor, with no villa to compare with.)

A date written for a record may be at most **tomorrow (UTC)**; a later one answers `400 VALIDATION_ERROR` on that field.

#### The villa detail daily reports tab

The villa detail page used to list `GET /daily-reports?villaId=<id>`. **That call now answers `400 VALIDATION_ERROR`** on the field `villaId` ("A daily report no longer belongs to a villa. Filter by contractorId or preparedByEngineerId instead"): the filter is refused, never ignored, so a page that still sends it fails loudly instead of showing every report as if they were the villa's. There is **no villa-scoped endpoint** for daily reports. For the tab, use the villa's contractor, which the villa already carries (`contractor.id` in `VillaDetailDto`):

- `GET /daily-reports?contractorId=<villa.contractor.id>` lists that contractor's reports, newest first (add `reportFrom`, `reportTo`, `weather` or `preparedByEngineerId` as needed). Those are the contractor's reports on **all** its villas, not only this one: say so in the tab's title ("Daily reports of the contractor ..."), or drop the tab from the villa page and link to the daily reports page filtered by contractor.
- A villa with **no contractor** has no daily reports to show: do not call the list without a filter for it.
- The same applies to the dashboard (`dailyReports.today` counts all reports of the day) and to the contractor summary (`dailyReports.count`).

## Open works

The work still to be done on a villa, **filed under one electrical phase**: a status, a priority, a progress and a window of dates. An open work has no title or description of its own: the phase says what it is, and the audit log calls it `<phase name> - <villa number>`.

- **Every open work is added by hand.** The system makes none and changes none: the electrical phase progress does not reach the open works. **A villa has at most one open work per electrical phase**: a second one is `409 OPEN_WORK_PHASE_TAKEN` (on `elecPhaseId`), whether it is added or an existing one is moved onto that phase; edit the one the villa has instead.
- **The electrical phase is required** for a manual item (`elecPhaseId`, by id; fetch the choices from `GET /elec-phases/options`, which needs `elec-phases:read`). It must exist (`404 ELEC_PHASE_NOT_FOUND`) and be active (`409 ELEC_PHASE_INACTIVE`) when it is chosen. A manual item can be moved to another active phase with a `PATCH`; an automatic item cannot (it follows its phase). A phase that open works are filed under cannot be deleted (`ELEC_PHASE_IN_USE`): switch it off instead.
- **Status and progress agree.** `DONE` needs 100, `NOT_STARTED` needs 0 (`WORK_STATUS_PROGRESS_MISMATCH`, 422). Leave the status out and the progress decides it: 0 `NOT_STARTED`, 1 to 99 `IN_PROGRESS`, 100 `DONE`.
- **`overdue`** is derived: the end date is before today **in `APP_TIMEZONE`** (the zone the small works use too) and the work is not done, so a work becomes overdue at local midnight after its end date. `overdueDays` is how many whole days late it is (0 when it is not overdue). The `overdue` filter, the dashboard and the contractor summary use the same rule.
- **Alerts:** once an open work is overdue, the hourly job raises one `OPEN_WORK_OVERDUE` [notification](#notifications) for every administrator and every user with `open-works:read`. A moved end date that is late again raises a new one. These are in-app only: they are not in the digest email.
- The default sort is `location` ascending (the villa's area, block and plot, in natural order), then the phase's place in the phases list.
- **Removed in this version:** `title` and the kind of work `phase` (`FOUNDATION`, `STRUCTURE`, `MEP`, `FINISHING`, `EXTERNAL`) are gone from the answer, the bodies, the filters, the sorts, the import and the export. A body that still carries them is refused as an unknown field; a `phase` query parameter is ignored like any unknown one (it no longer filters), so remove it from the page.

#### `OpenWorkDto`

| Field         | Type                                                    | Notes                                                                          |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id`          | `string`                                                | uuid                                                                           |
| `villa`       | `{ id: string; villaNumber: string; location: string }` | `{ id, villaNumber, location }`.                                               |
| `elecPhase`   | `{ id: string; name: string }`                          | `{ id, name }` of the electrical phase it is filed under. Always present.      |
| `status`      | `WorkStatusValue`                                       | `NOT_STARTED`, `IN_PROGRESS`, `DELAYED` or `DONE`.                             |
| `priority`    | `PriorityValue`                                         | `LOW`, `MEDIUM` or `HIGH`.                                                     |
| `progress`    | `number`                                                | 0 to 100.                                                                      |
| `contractor`  | `{ id: string; name: string } \| null`                  | `{ id, name }`, or null.                                                       |
| `startDate`   | `string \| null`                                        | `YYYY-MM-DD`, or null.                                                         |
| `endDate`     | `string \| null`                                        | `YYYY-MM-DD`, or null.                                                         |
| `overdue`     | `boolean`                                               | The end date is before today (APP_TIMEZONE) and the work is not done.          |
| `overdueDays` | `number`                                                | How many days past the end date the work is; 0 when it is not overdue.         |
| `createdBy`   | `{ id: string; name: string } \| null`                  | Who made it; null for the system or a user who has since been deleted.         |
| `version`     | `number`                                                | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`   | `string`                                                | ISO 8601 instant, UTC.                                                         |
| `updatedAt`   | `string`                                                | ISO 8601 instant, UTC.                                                         |

**Statuses**

<!-- list: WORK_STATUSES -->

`NOT_STARTED`, `IN_PROGRESS`, `DELAYED`, `DONE`

**Priorities**

<!-- list: PRIORITIES -->

`LOW`, `MEDIUM`, `HIGH`

**List** `GET /open-works`

<!-- query: listOpenWorksQuerySchema -->

| Parameter      | Type                                            | Notes                                                                                                                                                         |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`         | integer, 1 or more (default 1)                  |                                                                                                                                                               |
| `limit`        | integer, 1 to 1,000 (default 20)                |                                                                                                                                                               |
| `sort`         | `field`, `field:asc` or `field:desc`: see Sorts |                                                                                                                                                               |
| `villaId`      | uuid                                            |                                                                                                                                                               |
| `elecPhaseId`  | uuid                                            | The electrical phase the work is filed under.                                                                                                                 |
| `status`       | `NOT_STARTED`, `IN_PROGRESS`, `DELAYED`, `DONE` | Filter by status.                                                                                                                                             |
| `priority`     | `LOW`, `MEDIUM`, `HIGH`                         |                                                                                                                                                               |
| `contractorId` | uuid                                            |                                                                                                                                                               |
| `overdue`      | `true` or `false`                               | `true`: end date before today (APP_TIMEZONE) and not done. `false`: the rest.                                                                                 |
| `done`         | `true` or `false`                               | `true`: only the done works (status `DONE`, progress 100), what the Done Works page lists. `false`: only the ones still open, what the open works page lists. |
| `startFrom`    | date `YYYY-MM-DD`                               | Start date on or after this day.                                                                                                                              |
| `startTo`      | date `YYYY-MM-DD`                               | Start date on or before this day.                                                                                                                             |
| `endFrom`      | date `YYYY-MM-DD`                               | End date on or after this day.                                                                                                                                |
| `endTo`        | date `YYYY-MM-DD`                               | End date on or before this day.                                                                                                                               |
| `search`       | text, up to 100 characters                      | Matches the villa number, the electrical phase's name or the contractor's name.                                                                               |

**Sorts**

<!-- list: OPEN_WORK_SORT_FIELDS -->

`location`, `elecPhaseName`, `status`, `priority`, `progress`, `startDate`, `endDate`

**Create** `POST /open-works`, **change** `PATCH /open-works/:id` (at least one field)

<!-- body: createOpenWorkSchema -->

| Field          | Required | Type                         | Notes                                                                                                                                                         |
| -------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `villaId`      | Yes      | uuid                         |                                                                                                                                                               |
| `elecPhaseId`  | Yes      | uuid                         | An active electrical phase: `404 ELEC_PHASE_NOT_FOUND`, `409 ELEC_PHASE_INACTIVE`.                                                                            |
| `status`       | No       | `ACTIVE` or `INACTIVE`       | Left out: `progress` decides (0 `NOT_STARTED`, 1 to 99 `IN_PROGRESS`, 100 `DONE`). `DONE` needs 100, `NOT_STARTED` needs 0 (`WORK_STATUS_PROGRESS_MISMATCH`). |
| `priority`     | No       | `LOW`, `MEDIUM`, `HIGH`      | Default `MEDIUM`.                                                                                                                                             |
| `progress`     | No       | integer, 0 to 100            | Default 0 (100 when the status is `DONE`).                                                                                                                    |
| `contractorId` | No       | uuid, or `null`              | Must be the villa's own active contractor (`CONTRACTOR_NOT_ON_VILLA`, `CONTRACTOR_INACTIVE`).                                                                 |
| `startDate`    | No       | date `YYYY-MM-DD`, or `null` |                                                                                                                                                               |
| `endDate`      | No       | date `YYYY-MM-DD`, or `null` | Not before the start date.                                                                                                                                    |

<!-- body: updateOpenWorkSchema -->

| Field          | Required | Type                         | Notes                                                                                        |
| -------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `elecPhaseId`  | No       | uuid                         | A manual item only (an automatic one follows its phase); an active phase; cannot be cleared. |
| `status`       | No       | `ACTIVE` or `INACTIVE`       |                                                                                              |
| `priority`     | No       | `LOW`, `MEDIUM`, `HIGH`      |                                                                                              |
| `progress`     | No       | integer, 0 to 100            |                                                                                              |
| `contractorId` | No       | uuid, or `null`              |                                                                                              |
| `startDate`    | No       | date `YYYY-MM-DD`, or `null` |                                                                                              |
| `endDate`      | No       | date `YYYY-MM-DD`, or `null` |                                                                                              |

<!-- modules: open-works -->

**Errors:** `CONTRACTOR_INACTIVE`, `CONTRACTOR_NOT_FOUND`, `CONTRACTOR_NOT_ON_VILLA`, `ELEC_PHASE_INACTIVE`, `ELEC_PHASE_NOT_FOUND`, `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`, `OPEN_WORK_PHASE_TAKEN`, `VILLA_NOT_FOUND`, `WORK_ITEM_NOT_FOUND`, `WORK_STATUS_PROGRESS_MISMATCH`

## Daily reports

What one contractor's site did on one day, as written by an electrical engineer: the weather, the workers and free notes. **A daily report belongs to a contractor and to the electrical engineer who prepared it. It does not belong to a villa** (see [the villa detail tab](#the-villa-detail-daily-reports-tab)).

- **One report per contractor per day** (`DAILY_REPORT_EXISTS`, 409). Changing the date or the contractor to a pair that already has a report is the same error.
- **`contractorId` and `preparedByEngineerId` are both required**, by id. The contractor must exist (`404 CONTRACTOR_NOT_FOUND`) and be active (`400 CONTRACTOR_INACTIVE`); the engineer must exist (`404 ELECTRICAL_ENGINEER_NOT_FOUND`) and be active (`400 ELECTRICAL_ENGINEER_INACTIVE`). A report whose contractor or engineer was switched off afterwards can still be read and changed in its other fields; only choosing that party again is refused. Neither can be cleared.
- The old free-text `preparedBy`, the `workDone` text and the `villaId` are gone. The old `issues` text is now **`notes`** (up to 5,000 characters, or null).
- **`villaId` is refused in the list query** with `400 VALIDATION_ERROR` on the field `villaId` (never ignored): use `contractorId`.
- The default sort is `reportDate` descending. The search looks in the notes only.

#### `DailyReportDto`

| Field          | Type                                   | Notes                                                                          |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `id`           | `string`                               | uuid                                                                           |
| `reportDate`   | `string`                               | YYYY-MM-DD                                                                     |
| `weather`      | `WeatherValue`                         | `HOT`, `SUNNY`, `WINDY`, `RAINY` or `DUSTY`.                                   |
| `workersCount` | `number`                               | 0 to 100,000.                                                                  |
| `notes`        | `string \| null`                       | Up to 5,000 characters, or null.                                               |
| `contractor`   | `{ id: string; name: string }`         | `{ id, name }` of the contractor the report is about. Always present.          |
| `preparedBy`   | `{ id: string; name: string }`         | `{ id, name }` of the electrical engineer who prepared it. Always present.     |
| `createdBy`    | `{ id: string; name: string } \| null` | Who made it; null for the system or a user who has since been deleted.         |
| `version`      | `number`                               | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`    | `string`                               | ISO 8601 instant, UTC.                                                         |
| `updatedAt`    | `string`                               | ISO 8601 instant, UTC.                                                         |

**Weather**

<!-- list: WEATHERS -->

`HOT`, `SUNNY`, `WINDY`, `RAINY`, `DUSTY`

**List** `GET /daily-reports`

<!-- query: listDailyReportsQuerySchema -->

| Parameter              | Type                                            | Notes                                                                         |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `page`                 | integer, 1 or more (default 1)                  |                                                                               |
| `limit`                | integer, 1 to 1,000 (default 20)                |                                                                               |
| `sort`                 | `field`, `field:asc` or `field:desc`: see Sorts |                                                                               |
| `villaId`              | (retired)                                       | Any value answers `400 VALIDATION_ERROR` on `villaId`: a report has no villa. |
| `contractorId`         | uuid                                            |                                                                               |
| `preparedByEngineerId` | uuid                                            | The electrical engineer who prepared the report.                              |
| `weather`              | `HOT`, `SUNNY`, `WINDY`, `RAINY`, `DUSTY`       |                                                                               |
| `reportFrom`           | date `YYYY-MM-DD`                               | Report date on or after this day.                                             |
| `reportTo`             | date `YYYY-MM-DD`                               | Report date on or before this day.                                            |
| `search`               | text, up to 100 characters                      | Matches the notes.                                                            |

**Sorts**

<!-- list: DAILY_REPORT_SORT_FIELDS -->

`reportDate`, `contractorName`, `preparedByName`, `weather`, `createdAt`

**Create** `POST /daily-reports`, **change** `PATCH /daily-reports/:id` (at least one field)

<!-- body: createDailyReportSchema -->

| Field                  | Required | Type                                          | Notes                                                                                                   |
| ---------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `contractorId`         | Yes      | uuid                                          | An active contractor: `404 CONTRACTOR_NOT_FOUND`, `400 CONTRACTOR_INACTIVE`.                            |
| `preparedByEngineerId` | Yes      | uuid                                          | An active electrical engineer: `404 ELECTRICAL_ENGINEER_NOT_FOUND`, `400 ELECTRICAL_ENGINEER_INACTIVE`. |
| `reportDate`           | Yes      | date `YYYY-MM-DD`                             | One report per contractor per day (`DAILY_REPORT_EXISTS`). At most tomorrow (UTC).                      |
| `weather`              | Yes      | `HOT`, `SUNNY`, `WINDY`, `RAINY`, `DUSTY`     |                                                                                                         |
| `workersCount`         | Yes      | integer, 0 to 100,000                         |                                                                                                         |
| `notes`                | No       | text, up to 5,000 characters, or `null`/empty |                                                                                                         |

<!-- body: updateDailyReportSchema -->

| Field                  | Required | Type                                          | Notes                             |
| ---------------------- | -------- | --------------------------------------------- | --------------------------------- |
| `contractorId`         | No       | uuid                                          | Cannot be cleared; only replaced. |
| `preparedByEngineerId` | No       | uuid                                          | Cannot be cleared; only replaced. |
| `reportDate`           | No       | date `YYYY-MM-DD`                             |                                   |
| `weather`              | No       | `HOT`, `SUNNY`, `WINDY`, `RAINY`, `DUSTY`     |                                   |
| `workersCount`         | No       | integer, 0 to 100,000                         |                                   |
| `notes`                | No       | text, up to 5,000 characters, or `null`/empty |                                   |

<!-- modules: daily-reports -->

**Errors:** `CONTRACTOR_INACTIVE`, `CONTRACTOR_NOT_FOUND`, `DAILY_REPORT_EXISTS`, `DAILY_REPORT_NOT_FOUND`, `ELECTRICAL_ENGINEER_INACTIVE`, `ELECTRICAL_ENGINEER_NOT_FOUND`, `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`

## Daily small works

A small job to do on a villa by a contractor, between a start date and an end date. It has a description only: no quantity and no unit. The end date is the deadline: a pending work becomes **overdue** when its end date has passed, and **due soon** in the last hours before that.

- There is no natural key: the same text may be written twice.
- There is no quantity and no unit any more (`qty` and `unit` were removed from the answer, the bodies, the sorts, the import and the export; a body that still carries them is refused as an unknown field).
- The default sort is `endDate` descending.
- **The contractor is required** and is sent by id: any **active** contractor (the villa does not have to be the contractor's). An unknown id is `404 CONTRACTOR_NOT_FOUND`; one that is switched off is `400 CONTRACTOR_INACTIVE`. A work whose contractor has been switched off since can still be read, changed in its other fields and listed; only choosing that contractor again is refused.
- **Both dates are required** and are plain days (`YYYY-MM-DD`). An end date before the start date is `422 SMALL_WORK_DATE_RANGE_INVALID`; a date more than 10 years from today is a 400 on that field. There is no "not in the future" rule: the dates are planned ahead. A `PATCH` that sends only one of the two is checked against the one stored.
- **`overdue`, `dueSoon` and `deadlineAt` are worked out by the server and never sent.** The deadline is the **end of the end date in the application time zone** (`APP_TIMEZONE`, `Asia/Kuwait` by default; see [operations.md](operations.md#small-work-deadlines-and-alerts)), and `deadlineAt` is that instant. A work is `overdue` when it is `PENDING` and `deadlineAt` has passed; `dueSoon` when it is `PENDING`, not overdue, and `deadlineAt` is less than `SMALL_WORKS_ALERT_HOURS_BEFORE` hours away (8 by default). A `DONE` work is neither. They are never both `true`. Use them for badges; do not compute them from the dates in the browser, whose clock and zone may differ.
- Everything else that depends on "today" in this API is still the **UTC day** ([below](#the-utc-day)); this is the one exception, and it only affects these two flags, their filters, the dashboard's small works figures and the alerts.
- **Alerts:** when a pending work becomes due soon, and when it becomes overdue, every administrator and every user with `small-works:read` gets one [notification](#notifications), and the administrators get one digest email per hourly run. See [Notifications](#notifications).
- Import, export and the template have the same columns as the list: see [imports-exports.md](imports-exports.md#small-works).

#### `SmallWorkDto`

| Field         | Type                                                    | Notes                                                                                                                       |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string`                                                | uuid                                                                                                                        |
| `villa`       | `{ id: string; villaNumber: string; location: string }` | `{ id, villaNumber, location }`.                                                                                            |
| `contractor`  | `{ id: string; name: string }`                          | The contractor doing the work: `{ id, name }`. Always present.                                                              |
| `startDate`   | `string`                                                | YYYY-MM-DD                                                                                                                  |
| `endDate`     | `string`                                                | YYYY-MM-DD, on or after `startDate`. The last day of the work: the deadline is the end of this day.                         |
| `deadlineAt`  | `string`                                                | ISO 8601 instant, UTC: the start of the day after `endDate` in the application time zone. From then on the work is overdue. |
| `overdue`     | `boolean`                                               | Derived: `PENDING` and past `deadlineAt`. Always `false` for a `DONE` work.                                                 |
| `dueSoon`     | `boolean`                                               | Derived: `PENDING`, not overdue, and within the alert hours of `deadlineAt`. Always `false` for a `DONE` work.              |
| `description` | `string`                                                | Up to 500 characters.                                                                                                       |
| `status`      | `SmallWorkStatusValue`                                  | `PENDING` or `DONE`.                                                                                                        |
| `createdBy`   | `{ id: string; name: string } \| null`                  | Who made it; null for the system or a user who has since been deleted.                                                      |
| `version`     | `number`                                                | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite.                                              |
| `createdAt`   | `string`                                                | ISO 8601 instant, UTC.                                                                                                      |
| `updatedAt`   | `string`                                                | ISO 8601 instant, UTC.                                                                                                      |

**Statuses**

<!-- list: SMALL_WORK_STATUSES -->

`PENDING`, `DONE`

**List** `GET /small-works`

<!-- query: listSmallWorksQuerySchema -->

| Parameter      | Type                                            | Notes                                                                    |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `page`         | integer, 1 or more (default 1)                  |                                                                          |
| `limit`        | integer, 1 to 1,000 (default 20)                |                                                                          |
| `sort`         | `field`, `field:asc` or `field:desc`: see Sorts |                                                                          |
| `villaId`      | uuid                                            |                                                                          |
| `contractorId` | uuid                                            | Only this contractor's works.                                            |
| `status`       | `PENDING`, `DONE`                               | Filter by status.                                                        |
| `startFrom`    | date `YYYY-MM-DD`                               | Start date on or after this day.                                         |
| `startTo`      | date `YYYY-MM-DD`                               | Start date on or before this day. Before `startFrom` is a 400.           |
| `endFrom`      | date `YYYY-MM-DD`                               | End date on or after this day.                                           |
| `endTo`        | date `YYYY-MM-DD`                               | End date on or before this day. Before `endFrom` is a 400.               |
| `overdue`      | `true`, `false`                                 | `true`: only the works whose `overdue` is true. `false`: all the others. |
| `dueSoon`      | `true`, `false`                                 | `true`: only the works whose `dueSoon` is true. `false`: all the others. |
| `search`       | text, up to 100 characters                      | Matches the description, the contractor's name, or the villa number.     |

**Sorts**

<!-- list: SMALL_WORK_SORT_FIELDS -->

`startDate`, `endDate`, `villaNumber`, `contractorName`, `status`, `createdAt`

**Create** `POST /small-works`, **change** `PATCH /small-works/:id`

<!-- body: createSmallWorkSchema -->

| Field          | Required | Type                   | Notes                                                                        |
| -------------- | -------- | ---------------------- | ---------------------------------------------------------------------------- |
| `villaId`      | Yes      | uuid                   |                                                                              |
| `contractorId` | Yes      | uuid                   | An active contractor: 404 `CONTRACTOR_NOT_FOUND`, 400 `CONTRACTOR_INACTIVE`. |
| `startDate`    | Yes      | date `YYYY-MM-DD`      | Within 10 years of today.                                                    |
| `endDate`      | Yes      | date `YYYY-MM-DD`      | On or after `startDate` (else 422); within 10 years of today.                |
| `description`  | Yes      | string, min 1, max 500 |                                                                              |
| `status`       | No       | `PENDING` or `DONE`    | Default `PENDING`.                                                           |

<!-- body: updateSmallWorkSchema -->

| Field          | Required | Type                   | Notes                                |
| -------------- | -------- | ---------------------- | ------------------------------------ |
| `contractorId` | No       | uuid                   | Cannot be cleared; only replaced.    |
| `startDate`    | No       | date `YYYY-MM-DD`      | Checked against the stored end date. |
| `endDate`      | No       | date `YYYY-MM-DD`      | Checked against the stored start.    |
| `description`  | No       | string, min 1, max 500 |                                      |
| `status`       | No       | `PENDING` or `DONE`    |                                      |

The villa cannot be changed after the work is made (`villaId` in a `PATCH` is refused as an unknown field). Moving a work back from `DONE` to `PENDING`, or giving it a later end date, makes the alerts possible again for the new situation.

<!-- modules: small-works -->

**Errors:** `CONTRACTOR_INACTIVE`, `CONTRACTOR_NOT_FOUND`, `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`, `SMALL_WORK_DATE_RANGE_INVALID`, `SMALL_WORK_NOT_FOUND`, `VILLA_NOT_FOUND`

## Notifications

What the server raises for the signed-in user. There are three kinds: two about a small work, `SMALL_WORK_DUE_SOON` (a pending work entered its last hours before the deadline) and `SMALL_WORK_OVERDUE` (a pending work passed its deadline), and one about an open work, `OPEN_WORK_OVERDUE` (an open work that is not done passed its end date, in `APP_TIMEZONE`). An open work's notification goes to every active administrator and every active user holding `open-works:read`, once per end date, and is never emailed.

- **Own notifications only.** Every call is scoped to the caller; there is no way to read or mark someone else's. A notification that is not yours is `404 NOTIFICATION_NOT_FOUND`, the same as one that does not exist. No permission code is needed beyond being signed in.
- **Who gets them:** every active administrator and every active user holding `small-works:read`, at the moment the hourly job (and once at startup) finds the work in that situation. One notification per work, per situation and per end date: a work that stays due soon does not raise it again at every run. Giving the work a later end date, or moving it from `DONE` back to `PENDING`, is a new situation and can raise it again. A work that is marked `DONE` raises nothing.
- **Read state is per user.** `read` and `readAt` are the caller's own; marking a notification read does not change it for anyone else.
- **Both languages are in the answer** (`title` and `body` are `{ en, ar }`), so the client can switch language without asking again. The text is kept as it was when the notification was raised (`data`), so it does not change when the work is edited later. Use `entity` to open the work.
- The list is newest first. `meta.unreadCount` is the caller's unread notifications over the **whole** list, not only this page or filter: use it for the badge.
- **Poll** `GET /notifications?unread=true&limit=1` (about once a minute is enough) and read `meta.unreadCount`; there is no push channel.
- The administrators also get one digest email per run that raised something: a single message, English first and then Arabic (right to left), listing the works that became due soon or overdue.

#### `NotificationDto`

| Field       | Type                                                                                    | Notes                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | `string`                                                                                | uuid                                                                                                                                                                                   |
| `kind`      | `NotificationKindValue`                                                                 | `SMALL_WORK_DUE_SOON`, `SMALL_WORK_OVERDUE` or `OPEN_WORK_OVERDUE`.                                                                                                                    |
| `title`     | `{ en: string; ar: string }`                                                            | The headline, in both languages.                                                                                                                                                       |
| `body`      | `{ en: string; ar: string }`                                                            | The sentence, in both languages.                                                                                                                                                       |
| `entity`    | `{ type: "SMALL_WORK" \| "OPEN_WORK"; id: string; villaId: string }`                    | What to open. `id` is the small work's or the open work's id.                                                                                                                          |
| `data`      | `{ villaNumber: string; description: string; contractorName: string; endDate: string }` | The facts of the alert as they were when it was raised. `endDate` is YYYY-MM-DD. For an open work, `description` is its electrical phase and `contractorName` is `-` when it has none. |
| `read`      | `boolean`                                                                               | Whether the caller has read it.                                                                                                                                                        |
| `readAt`    | `string \| null`                                                                        | ISO 8601 instant, UTC, or null while unread.                                                                                                                                           |
| `createdAt` | `string`                                                                                | ISO 8601 instant, UTC: when the alert was raised.                                                                                                                                      |

**Kinds**

<!-- list: NOTIFICATION_KINDS -->

`SMALL_WORK_DUE_SOON`, `SMALL_WORK_OVERDUE`, `OPEN_WORK_OVERDUE`

**List** `GET /notifications`

<!-- query: listNotificationsQuerySchema -->

| Parameter | Type                             | Notes                                                                                   |
| --------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `page`    | integer, 1 or more (default 1)   |                                                                                         |
| `limit`   | integer, 1 to 1,000 (default 20) |                                                                                         |
| `unread`  | `true`, `false`                  | `true`: only the notifications the caller has not read. `false` or absent: all of them. |

The answer is `{ data: NotificationDto[], meta }`, where `meta` is the usual page meta plus `unreadCount` (a number).

**Mark one read** `POST /notifications/:id/read`: answers the `NotificationDto` with `read: true`. Doing it twice is harmless and keeps the first `readAt`. No body, no `Idempotency-Key`.

**Mark all read** `POST /notifications/read-all`: answers `{ data: { updated: number } }`, the number of notifications that were unread. No body.

<!-- modules: notifications -->

**Errors:** `NOTIFICATION_NOT_FOUND`

## Site reports

A visit to a villa by an inspector: what was found and what to do, with a rating from 1 to 5.

- No natural key: a villa may have several visits on a day.
- The default sort is `visitDate` descending.

#### `SiteReportDto`

| Field             | Type                                                    | Notes                                                                          |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id`              | `string`                                                | uuid                                                                           |
| `villa`           | `{ id: string; villaNumber: string; location: string }` | `{ id, villaNumber, location }`.                                               |
| `visitDate`       | `string`                                                | YYYY-MM-DD                                                                     |
| `title`           | `string`                                                | Up to 150 characters.                                                          |
| `inspector`       | `string`                                                | Up to 100 characters.                                                          |
| `type`            | `SiteReportTypeValue`                                   | `INSPECTION`, `SAFETY`, `PROGRESS` or `QUALITY`.                               |
| `rating`          | `number`                                                | 1 to 5                                                                         |
| `findings`        | `string`                                                | Up to 5,000 characters.                                                        |
| `recommendations` | `string \| null`                                        | Up to 5,000 characters, or null.                                               |
| `createdBy`       | `{ id: string; name: string } \| null`                  | Who made it; null for the system or a user who has since been deleted.         |
| `version`         | `number`                                                | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`       | `string`                                                | ISO 8601 instant, UTC.                                                         |
| `updatedAt`       | `string`                                                | ISO 8601 instant, UTC.                                                         |

**Types**

<!-- list: SITE_REPORT_TYPES -->

`INSPECTION`, `SAFETY`, `PROGRESS`, `QUALITY`

**List** `GET /site-reports`

<!-- query: listSiteReportsQuerySchema -->

| Parameter   | Type                                            | Notes                                                  |
| ----------- | ----------------------------------------------- | ------------------------------------------------------ |
| `page`      | integer, 1 or more (default 1)                  |                                                        |
| `limit`     | integer, 1 to 1,000 (default 20)                |                                                        |
| `sort`      | `field`, `field:asc` or `field:desc`: see Sorts |                                                        |
| `villaId`   | uuid                                            |                                                        |
| `type`      | `INSPECTION`, `SAFETY`, `PROGRESS`, `QUALITY`   |                                                        |
| `rating`    | integer, 1 to 5                                 | Exactly this rating.                                   |
| `visitFrom` | date `YYYY-MM-DD`                               | Visit date on or after this day.                       |
| `visitTo`   | date `YYYY-MM-DD`                               | Visit date on or before this day.                      |
| `search`    | text, up to 100 characters                      | Matches the title, the inspector, or the villa number. |

**Sorts**

<!-- list: SITE_REPORT_SORT_FIELDS -->

`visitDate`, `villaNumber`, `rating`, `type`, `createdAt`

**Create** `POST /site-reports`, **change** `PATCH /site-reports/:id`

<!-- body: createSiteReportSchema -->

| Field             | Required | Type                                          | Notes                   |
| ----------------- | -------- | --------------------------------------------- | ----------------------- |
| `villaId`         | Yes      | uuid                                          |                         |
| `title`           | Yes      | string, min 1, max 150                        |                         |
| `visitDate`       | Yes      | date `YYYY-MM-DD`                             | At most tomorrow (UTC). |
| `inspector`       | Yes      | string, min 1, max 100                        |                         |
| `type`            | Yes      | `INSPECTION`, `SAFETY`, `PROGRESS`, `QUALITY` |                         |
| `rating`          | Yes      | integer, 1 to 5                               |                         |
| `findings`        | Yes      | string, min 1, max 5000                       |                         |
| `recommendations` | No       | text, up to 5,000 characters, or `null`/empty |                         |

<!-- body: updateSiteReportSchema -->

| Field             | Required | Type                                          | Notes |
| ----------------- | -------- | --------------------------------------------- | ----- |
| `title`           | No       | string, min 1, max 150                        |       |
| `visitDate`       | No       | date `YYYY-MM-DD`                             |       |
| `inspector`       | No       | string, min 1, max 100                        |       |
| `type`            | No       | `INSPECTION`, `SAFETY`, `PROGRESS`, `QUALITY` |       |
| `rating`          | No       | integer, 1 to 5                               |       |
| `findings`        | No       | string, min 1, max 5000                       |       |
| `recommendations` | No       | text, up to 5,000 characters, or `null`/empty |       |

<!-- modules: site-reports -->

**Errors:** `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`, `SITE_REPORT_NOT_FOUND`, `VILLA_NOT_FOUND`

## Daily labour

How many workers a contractor had on a villa on a day.

- **One row per villa, contractor and day** (`DAILY_LABOUR_EXISTS`, 409).
- The contractor must be the villa's own and active, as for every record of a villa.
- The default sort is `labourDate` descending.

#### `DailyLabourDto`

| Field         | Type                                                    | Notes                                                                          |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id`          | `string`                                                | uuid                                                                           |
| `villa`       | `{ id: string; villaNumber: string; location: string }` | `{ id, villaNumber, location }`.                                               |
| `labourDate`  | `string`                                                | YYYY-MM-DD                                                                     |
| `contractor`  | `{ id: string; name: string }`                          | `{ id, name }`.                                                                |
| `labourCount` | `number`                                                | Workers the contractor had on site, 0 to 100,000.                              |
| `notes`       | `string \| null`                                        | Up to 500 characters, or null.                                                 |
| `createdBy`   | `{ id: string; name: string } \| null`                  | Who made it; null for the system or a user who has since been deleted.         |
| `version`     | `number`                                                | Counts the changes, from 1. Send it back as `If-Match` to refuse an overwrite. |
| `createdAt`   | `string`                                                | ISO 8601 instant, UTC.                                                         |
| `updatedAt`   | `string`                                                | ISO 8601 instant, UTC.                                                         |

**List** `GET /daily-labour`

<!-- query: listDailyLabourQuerySchema -->

| Parameter      | Type                                            | Notes                                                          |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `page`         | integer, 1 or more (default 1)                  |                                                                |
| `limit`        | integer, 1 to 1,000 (default 20)                |                                                                |
| `sort`         | `field`, `field:asc` or `field:desc`: see Sorts |                                                                |
| `villaId`      | uuid                                            |                                                                |
| `contractorId` | uuid                                            |                                                                |
| `labourFrom`   | date `YYYY-MM-DD`                               | Labour date on or after this day.                              |
| `labourTo`     | date `YYYY-MM-DD`                               | Labour date on or before this day.                             |
| `search`       | text, up to 100 characters                      | Matches the villa number, the contractor's name, or the notes. |

**Sorts**

<!-- list: DAILY_LABOUR_SORT_FIELDS -->

`labourDate`, `villaNumber`, `contractorName`, `labourCount`, `createdAt`

**Create** `POST /daily-labour`, **change** `PATCH /daily-labour/:id`

<!-- body: createDailyLabourSchema -->

| Field          | Required | Type                                        | Notes                                                                                  |
| -------------- | -------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `villaId`      | Yes      | uuid                                        |                                                                                        |
| `labourDate`   | Yes      | date `YYYY-MM-DD`                           | One row per villa, contractor and day (`DAILY_LABOUR_EXISTS`). At most tomorrow (UTC). |
| `contractorId` | Yes      | uuid, or `null`                             | Must be the villa's own active contractor.                                             |
| `labourCount`  | Yes      | integer, 0 to 100,000                       |                                                                                        |
| `notes`        | No       | text, up to 500 characters, or `null`/empty |                                                                                        |

<!-- body: updateDailyLabourSchema -->

| Field          | Required | Type                                        | Notes |
| -------------- | -------- | ------------------------------------------- | ----- |
| `labourDate`   | No       | date `YYYY-MM-DD`                           |       |
| `contractorId` | No       | uuid, or `null`                             |       |
| `labourCount`  | No       | integer, 0 to 100,000                       |       |
| `notes`        | No       | text, up to 500 characters, or `null`/empty |       |

<!-- modules: daily-labour -->

**Errors:** `CONTRACTOR_INACTIVE`, `CONTRACTOR_NOT_FOUND`, `CONTRACTOR_NOT_ON_VILLA`, `DAILY_LABOUR_EXISTS`, `DAILY_LABOUR_NOT_FOUND`, `IMPORT_DATA_CHANGED`, `NO_FILE_PROVIDED`, `VILLA_NOT_FOUND`

## Dashboard

`GET /dashboard/summary` answers the figures of the home page as one object. It needs `dashboard:read`, and then shows only the **cards** the caller may see ([permissions.md](permissions.md#the-dashboard)).

- **Every key is always present.** A key is `null` when the caller lacks the permission of its card, and its figures are not even worked out. Hide a `null` card; do not show it as zero.
- **A card with nothing to count is not `null`:** it holds zeros, an empty list, and a `null` average where there is nothing to average.
- The **villas card** is seven keys that are all present or all `null` together: `villas`, `progress`, `overdue`, `upcoming`, `mewFollowUp`, `mewInspection`, `byArea`.
- `progress` counts villas **derived from the phase progress**: not started (0 in every active phase), done (100 in every one of them, and there is at least one), in progress otherwise. The three add up to `villas.total`; `average` is the mean overall progress, one decimal.
- `overdue` and `upcoming` look at the villas' **target date**: overdue is before today, upcoming is from today to 30 days ahead (a villa due today is upcoming). `mewFollowUp.count` is the villas on the MEW follow-up list, put there by a person, never derived from the progress. `mewInspection.count` is the villas on the MEW inspection list that have not passed it yet.
- `maintenance` (`maintenance:read`) counts the maintenance villas still `open` and the ones checked as `solved`.
- `byArea` lists up to 50 areas, `topContractors` the 10 contractors with the most villas.
- The daily figures (`dailyReports`, `labour`) are `today` and `last7Days` (today and the six days before it). `dailyReports` counts every contractor's reports (a report belongs to a contractor, not to a villa); `labour` adds up the workers. "Today" is the **UTC day** ([below](#the-utc-day)).
- `openWorks.total`, `smallWorks.total`, `smallWorks.pending`, `totalLabour.total` and `siteReports` are over all time. `smallWorks.dueSoon`, `smallWorks.overdue`, `delayedSmallWorks.dueSoon` and `delayedSmallWorks.overdue` count the pending works by the deadline rules of [Daily small works](#daily-small-works) (so they follow the application time zone and `SMALL_WORKS_ALERT_HOURS_BEFORE`, not the UTC day), and `smallWorks.urgent` lists up to 5 of those, earliest end date first (so the overdue ones come before the due soon ones), then the oldest. `delayedSmallWorks` is the same overdue and due soon counts as `smallWorks`, for a dedicated dashboard card.

#### `DashboardSummaryDto`

| Field               | Type                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `villas`            | `{ total: number } \| null`                                                                                                                                                              | The villas card (villas:read): villas, progress, overdue, upcoming, mewFollowUp and byArea.                                                                                                                                                                                                                                                                                              |
| `progress`          | `{ average: number; notStarted: number; inProgress: number; done: number } \| null`                                                                                                      | Derived on read from the phase progress, each phase read from the villa's open works. A villa is not started when it is at 0 in every active phase, done when it is at 100 in every one of them (and there is at least one), in progress otherwise. The three add up to the total. `average` is the mean of the villas' overall progress, with one decimal (0 with no villas or phases). |
| `overdue`           | `{ count: number } \| null`                                                                                                                                                              | Overdue and upcoming look at the target date of every villa.                                                                                                                                                                                                                                                                                                                             |
| `upcoming`          | `{ count: number } \| null`                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                          |
| `mewInspection`     | `{ count: number } \| null`                                                                                                                                                              | Villas on the MEW inspection list that have not passed it yet.                                                                                                                                                                                                                                                                                                                           |
| `mewFollowUp`       | `{ count: number } \| null`                                                                                                                                                              | Villas on the MEW follow-up list (put there by a person).                                                                                                                                                                                                                                                                                                                                |
| `byArea`            | `AreaCountsDto[] \| null`                                                                                                                                                                | Villas per area; an empty list with no villas.                                                                                                                                                                                                                                                                                                                                           |
| `topContractors`    | `ContractorCountsDto[] \| null`                                                                                                                                                          | The contractors with the most villas (up to 10, busiest first).                                                                                                                                                                                                                                                                                                                          |
| `openWorks`         | `{ total: number; delayed: number; byStatus: { NOT_STARTED: number; IN_PROGRESS: number; DELAYED: number; DONE: number }; overdue: number; overdueList: OverdueOpenWorkDto[]; } \| null` | Open works (open-works:read). `total` is all of them (the sum of `byStatus`); `delayed` is the ones whose status is `DELAYED` (the same number as `byStatus.DELAYED`). Overdue is the open-works list's own rule: an end date before today in `APP_TIMEZONE`, and not done. `overdueList` is up to 5 of those, the earliest end date first.                                              |
| `dailyReports`      | `DailyFiguresDto \| null`                                                                                                                                                                | Daily reports (daily-reports:read): how many were written for today, and for the last 7 days.                                                                                                                                                                                                                                                                                            |
| `smallWorks`        | `{ total: number; pending: number; dueSoon: number; overdue: number; urgent: UrgentSmallWorkDto[] } \| null`                                                                             | Daily small works (small-works:read): all of them (`total`, whatever the status); the ones still pending, over all time; how many of those are due soon and overdue (the rules of Daily small works, in the application time zone); and up to 5 of the most urgent of the latter two, earliest end date first.                                                                           |
| `siteReports`       | `{ count: number; averageRating: number \| null } \| null`                                                                                                                               | Site reports (site-reports:read): over all time. The average has one decimal and is null when there is no report.                                                                                                                                                                                                                                                                        |
| `labour`            | `DailyFiguresDto \| null`                                                                                                                                                                | Daily labour (daily-labour:read): the number of labourers, added up over the rows of today and of the last 7 days.                                                                                                                                                                                                                                                                       |
| `totalLabour`       | `{ total: number } \| null`                                                                                                                                                              | Total labour (daily-reports:read): the `workersCount` of every labour daily report added up, all time (not the number of reports).                                                                                                                                                                                                                                                       |
| `maintenance`       | `{ open: number; solved: number } \| null`                                                                                                                                               | Maintenance villas (maintenance:read): the ones still open, and the ones checked as solved.                                                                                                                                                                                                                                                                                              |
| `delayedSmallWorks` | `DelayedSmallWorksDto \| null`                                                                                                                                                           | Delayed small works (small-works:read): pending works that are overdue or due soon (same rules as notifications). Not the open-works `DELAYED` status.                                                                                                                                                                                                                                   |
| `generatedAt`       | `string`                                                                                                                                                                                 | ISO 8601 instant when the summary was worked out.                                                                                                                                                                                                                                                                                                                                        |

#### `DelayedSmallWorksDto`

| Field     | Type     | Notes                                                                      |
| --------- | -------- | -------------------------------------------------------------------------- |
| `overdue` | `number` | Pending works whose end date is before today in `APP_TIMEZONE`.            |
| `dueSoon` | `number` | Pending works due soon (`SMALL_WORKS_ALERT_HOURS_BEFORE` before deadline). |

#### `AreaCountsDto`

| Field    | Type     | Notes               |
| -------- | -------- | ------------------- |
| `areaId` | `string` | The area's id.      |
| `area`   | `string` | The area's name.    |
| `city`   | `string` |                     |
| `total`  | `number` | Villas in the area. |

#### `ContractorCountsDto`

| Field   | Type     | Notes                     |
| ------- | -------- | ------------------------- |
| `id`    | `string` | uuid                      |
| `name`  | `string` |                           |
| `total` | `number` | Villas of the contractor. |

#### `UrgentSmallWorkDto`

| Field         | Type                                  | Notes                                                 |
| ------------- | ------------------------------------- | ----------------------------------------------------- |
| `id`          | `string`                              | The small work's id.                                  |
| `villa`       | `{ id: string; villaNumber: string }` |                                                       |
| `description` | `string`                              |                                                       |
| `contractor`  | `{ id: string; name: string }`        |                                                       |
| `endDate`     | `string`                              | YYYY-MM-DD                                            |
| `deadlineAt`  | `string`                              | ISO 8601 instant, UTC: when the work becomes overdue. |
| `alert`       | `"overdue" \| "dueSoon"`              | Which of the two it is now.                           |

#### `OverdueOpenWorkDto`

| Field         | Type                                  | Notes                                               |
| ------------- | ------------------------------------- | --------------------------------------------------- |
| `id`          | `string`                              | The open work's id.                                 |
| `villa`       | `{ id: string; villaNumber: string }` |                                                     |
| `elecPhase`   | `{ name: string }`                    | The electrical phase it is filed under.             |
| `contractor`  | `{ name: string } \| null`            | null when the work has no contractor.               |
| `endDate`     | `string`                              | YYYY-MM-DD                                          |
| `overdueDays` | `number`                              | Whole days since the end date (1 the day after it). |

#### `DailyFiguresDto`

| Field       | Type     | Notes                            |
| ----------- | -------- | -------------------------------- |
| `today`     | `number` | For the UTC day.                 |
| `last7Days` | `number` | For the 7 UTC days ending today. |

An administrator's answer:

<!-- shape: DashboardSummaryDto -->

```json
{
  "villas": { "total": 120 },
  "progress": { "average": 42.5, "notStarted": 10, "inProgress": 90, "done": 20 },
  "overdue": { "count": 7 },
  "upcoming": { "count": 12 },
  "mewFollowUp": { "count": 5 },
  "mewInspection": { "count": 3 },
  "byArea": [
    { "areaId": "9d1a52f0-2b7e-4d6a-8c1f-5b3e7a90c412", "area": "New Cairo", "city": "Cairo", "total": 80 }
  ],
  "topContractors": [
    { "id": "e3e2d2c2-3333-4c4d-8e5f-607182930415", "name": "Nile Contracting", "total": 14 }
  ],
  "openWorks": {
    "total": 68,
    "delayed": 6,
    "byStatus": { "NOT_STARTED": 3, "IN_PROGRESS": 41, "DELAYED": 6, "DONE": 18 },
    "overdue": 4,
    "overdueList": [
      {
        "id": "0b6f2d4e-7a1c-4e9b-8d3f-5a2c1e0f9b84",
        "villa": { "id": "7c2e9b10-4a5d-4e3f-8a1b-9d6c0e2f4a58", "villaNumber": "P-014" },
        "elecPhase": { "name": "Wiring" },
        "contractor": { "name": "Nile Contracting" },
        "endDate": "2026-02-20",
        "overdueDays": 9
      }
    ]
  },
  "dailyReports": { "today": 31, "last7Days": 188 },
  "smallWorks": {
    "total": 30,
    "pending": 9,
    "dueSoon": 2,
    "overdue": 1,
    "urgent": [
      {
        "id": "5f0c7a52-1d3b-4a8e-9b6c-2e4d8f10a3b7",
        "villa": { "id": "7c2e9b10-4a5d-4e3f-8a1b-9d6c0e2f4a58", "villaNumber": "P-014" },
        "description": "Repair the garden wall",
        "contractor": { "id": "e3e2d2c2-3333-4c4d-8e5f-607182930415", "name": "Nile Contracting" },
        "endDate": "2026-02-27",
        "deadlineAt": "2026-02-27T21:00:00.000Z",
        "alert": "overdue"
      }
    ]
  },
  "siteReports": { "count": 64, "averageRating": 4.2 },
  "labour": { "today": 412, "last7Days": 2810 },
  "totalLabour": { "total": 128450 },
  "delayedSmallWorks": { "overdue": 1, "dueSoon": 2 },
  "maintenance": { "open": 4, "solved": 9 },
  "generatedAt": "2026-03-01T09:30:00.000Z"
}
```

An employee who holds only `dashboard:read`, `villas:read` and `daily-reports:read`:

<!-- shape-top: DashboardSummaryDto -->

```json
{
  "villas": { "total": 120 },
  "progress": { "average": 42.5, "notStarted": 10, "inProgress": 90, "done": 20 },
  "overdue": { "count": 7 },
  "upcoming": { "count": 12 },
  "mewFollowUp": { "count": 5 },
  "mewInspection": { "count": 3 },
  "byArea": [
    { "areaId": "9d1a52f0-2b7e-4d6a-8c1f-5b3e7a90c412", "area": "New Cairo", "city": "Cairo", "total": 80 }
  ],
  "topContractors": null,
  "openWorks": null,
  "dailyReports": { "today": 31, "last7Days": 188 },
  "smallWorks": null,
  "siteReports": null,
  "labour": null,
  "totalLabour": { "total": 5240 },
  "delayedSmallWorks": null,
  "maintenance": null,
  "generatedAt": "2026-03-01T09:30:00.000Z"
}
```

`GET /dashboard/recent-activity` answers the latest audit entries, newest first, as an array of `AuditLogListItemDto` (see [Audit log](#audit-log)); it is in the language of the request.

<!-- query: recentActivityQuerySchema -->

| Parameter | Type                          | Notes             |
| --------- | ----------------------------- | ----------------- |
| `limit`   | integer, 1 to 50 (default 20) | How many entries. |

<!-- modules: dashboard -->

**Errors:** none of its own

## Audit log

An append-only record of who changed what: every create, change, delete, sign-in, import and export writes an entry in the same transaction as the change, and an entry can never be edited or deleted. It needs `audit:read`. The only change an entry ever undergoes is its `actor` becoming `null` when that user is deleted.

- A list item says **what happened** with a code and a label: `action` is the stable code (`villa.create`, what the `action` filter takes) and `actionLabel` is its meaning in the language of the request (`Accept-Language`). An action this version has no label for shows its code as the label.
- It says **what it was about** with `entity` (the label of the kind of record, translated), `entityCode` (the stable code, what the `entity` filter takes), `entityId`, `entityName` and `entityDetail`:
  - `entityName` is the record's name: a villa's number, a contractor's, engineer's or user's name, a file's original name. It is filled **also when the record has been deleted since**, from the entry's own snapshot, and is `null` only when no name can be found.
  - `entityDetail` is a second line that tells two of the same name apart: for a user it is the email, for every other entity `null`.
- **Filters need codes, not labels.** `GET /audit-logs/filters` gives the lists for the dropdowns: `actions` and `entities` are the codes, `actionLabels` and `entityLabels` map each code to its label in the language of the request, and `actors` are the users that appear in the log. The lists hold every action and entity the application knows, whether or not an entry exists for it yet, plus any only the log holds (an old one). Show the label, send the code.
- `search` matches the action and the entity **codes**, not the labels.
- Entries written before the villa rename carry the old codes; the `action` and `entity` filters match those as well.
- The detail (`GET /audit-logs/:id`) adds `before` and `after`, the record as it was and as it became (JSON, secrets removed), either of which is `null` when it does not apply.
- The default and only sort is `createdAt`, newest first.

#### `AuditActorDto`

| Field   | Type     | Notes                                               |
| ------- | -------- | --------------------------------------------------- |
| `id`    | `string` | uuid                                                |
| `name`  | `string` | The name now; the entry keeps pointing at the user. |
| `email` | `string` | The user's email now.                               |

#### `AuditLogListItemDto`

| Field          | Type                    | Notes                                                                                                                                                                                                                                           |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `string`                | uuid                                                                                                                                                                                                                                            |
| `actor`        | `AuditActorDto \| null` | Who did it; null for the system, or when the user has since been deleted.                                                                                                                                                                       |
| `action`       | `string`                | The stable code that is stored (what the `action` filter takes), e.g. `villa.create`.                                                                                                                                                           |
| `actionLabel`  | `string`                | What the action means, in the language of the request. The code itself for an action this version has no label for.                                                                                                                             |
| `entity`       | `string`                | The entity's label in the language of the request, e.g. `Villa` / `فيلا`.                                                                                                                                                                       |
| `entityCode`   | `string`                | The stable code the entity is stored under (what the `entity` filter takes), e.g. `Villa`.                                                                                                                                                      |
| `entityId`     | `string \| null`        | The id of the record the entry is about; null when none.                                                                                                                                                                                        |
| `entityName`   | `string \| null`        | What the entry is about, by name: a villa's number, a contractor's, engineer's or user's name, a file's original name. null when none can be found. Present for a record that has since been deleted too (taken from the entry's own snapshot). |
| `entityDetail` | `string \| null`        | A second line that tells two of the same name apart: a user's email. null for every other entity.                                                                                                                                               |
| `ip`           | `string \| null`        | null for a system action.                                                                                                                                                                                                                       |
| `userAgent`    | `string \| null`        | null for a system action.                                                                                                                                                                                                                       |
| `requestId`    | `string \| null`        | The `X-Request-Id` of the request that made the change.                                                                                                                                                                                         |
| `createdAt`    | `string`                | ISO 8601 instant, UTC.                                                                                                                                                                                                                          |

#### `AuditLogDetailDto`

| Field          | Type                    | Notes                                                                   |
| -------------- | ----------------------- | ----------------------------------------------------------------------- |
| `id`           | `string`                | uuid                                                                    |
| `actor`        | `AuditActorDto \| null` | As in the list.                                                         |
| `action`       | `string`                | As in the list.                                                         |
| `actionLabel`  | `string`                | As in the list.                                                         |
| `entity`       | `string`                | As in the list.                                                         |
| `entityCode`   | `string`                | As in the list.                                                         |
| `entityId`     | `string \| null`        | As in the list.                                                         |
| `entityName`   | `string \| null`        | As in the list.                                                         |
| `entityDetail` | `string \| null`        | As in the list.                                                         |
| `ip`           | `string \| null`        | As in the list.                                                         |
| `userAgent`    | `string \| null`        | As in the list.                                                         |
| `requestId`    | `string \| null`        | As in the list.                                                         |
| `createdAt`    | `string`                | ISO 8601 instant, UTC.                                                  |
| `before`       | `Json \| null`          | The record before the change (JSON), or null. Secrets are never stored. |
| `after`        | `Json \| null`          | The record after the change (JSON), or null.                            |

#### `AuditFiltersDto`

| Field          | Type                             | Notes                                                                                   |
| -------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `actions`      | `string[]`                       | Every action code the application knows, plus any that only the log holds (an old one). |
| `actionLabels` | `Record<string, string>`         | Object: action code to its label, in the language of the request.                       |
| `entities`     | `string[]`                       | Every entity code, as `actions`.                                                        |
| `entityLabels` | `Record<string, string>`         | Object: entity code to its label, in the language of the request.                       |
| `actors`       | `{ id: string; name: string }[]` | Users who appear in the log (at most 100), for a picker.                                |

A list item, in Arabic (`Accept-Language: ar` would translate `actionLabel` and `entity`):

<!-- shape: AuditLogListItemDto -->

```json
{
  "id": "0b8e2f4c-5d3a-4a1e-b6c7-9e8d7c6b5a40",
  "actor": { "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11", "name": "Mona Adel", "email": "mona@example.com" },
  "action": "user.deactivate",
  "actionLabel": "Deactivate user",
  "entity": "User",
  "entityCode": "User",
  "entityId": "7a2d3e4f-6b5c-4d8e-9f01-a2b3c4d5e6f7",
  "entityName": "Karim Fawzy",
  "entityDetail": "karim@example.com",
  "ip": "203.0.113.5",
  "userAgent": "Mozilla/5.0",
  "requestId": "0c5f2f4e-6a52-4a6b-9f3a-1c1f7b7a1d10",
  "createdAt": "2026-03-01T09:30:00.000Z"
}
```

The filters answer:

<!-- shape-top: AuditFiltersDto -->

```json
{
  "actions": ["user.activate", "user.deactivate", "villa.create"],
  "actionLabels": {
    "user.activate": "Activate user",
    "user.deactivate": "Deactivate user",
    "villa.create": "Create villa"
  },
  "entities": ["User", "Villa"],
  "entityLabels": { "User": "User", "Villa": "Villa" },
  "actors": [{ "id": "6f1c1c1e-3a52-4c0e-9d57-2a3a3f0f9a11", "name": "Mona Adel" }]
}
```

**List** `GET /audit-logs`

<!-- query: listAuditLogsQuerySchema -->

| Parameter  | Type                                            | Notes                                                                                      |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `page`     | integer, 1 or more (default 1)                  |                                                                                            |
| `limit`    | integer, 1 to 1,000 (default 20)                |                                                                                            |
| `sort`     | `field`, `field:asc` or `field:desc`: see Sorts |                                                                                            |
| `actorId`  | uuid                                            | One user's actions.                                                                        |
| `action`   | text, up to 100 characters                      | An action code. Entries written before the villa rename are matched by their old code too. |
| `entity`   | text, up to 100 characters                      | An entity code, e.g. `Villa`. Old codes match too.                                         |
| `entityId` | text, up to 100 characters                      | One record's history.                                                                      |
| `from`     | `YYYY-MM-DD` or an ISO 8601 instant             | A day alone starts at 00:00:00.000 UTC.                                                    |
| `to`       | `YYYY-MM-DD` or an ISO 8601 instant             | A day alone ends at 23:59:59.999 UTC. Not before `from` (400).                             |
| `search`   | text, up to 100 characters                      | Matches the action or the entity code.                                                     |

**Sorts**

<!-- list: AUDIT_SORT_FIELDS -->

`createdAt`

<!-- modules: audit -->

**Errors:** `AUDIT_LOG_NOT_FOUND`

## Health

`GET /health` needs no sign-in and has no `data` wrapper: `200 { "status": "ok" }`, or `503 { "status": "degraded" }` when the database does not answer. Use it for a load balancer or an uptime check.

#### `HealthStatusDto`

| Field    | Type                 | Notes                                                                           |
| -------- | -------------------- | ------------------------------------------------------------------------------- |
| `status` | `"ok" \| "degraded"` | `ok`, or `degraded` when the database does not answer (the status is then 503). |

## The UTC day

**Every date in the API is a UTC day, and "today" is the UTC day.** A calendar day travels as `YYYY-MM-DD` and is stored exactly as sent: the API never shifts it for a time zone. What the **server** works out from "now" is cut at UTC midnight:

- the dashboard's `today` and `last7Days` figures, `overdue` and `upcoming`;
- an open work's `overdue` flag and the `overdue` filter;
- the latest day a record may be dated (tomorrow, in UTC).

A site in Egypt is two hours ahead of UTC (three in summer time), so for the first two or three hours after local midnight the server still believes it is yesterday: a report written at 01:00 local on the 5th still counts toward the 4th's `today` figures, an item due on the 4th is not yet `overdue`, and a record dated the 6th (local tomorrow) is refused as too far ahead until UTC midnight passes. From then on the figures are right. A time (`createdAt`, `generatedAt`, an audit time) is an ISO 8601 instant: convert it to local time for display, and send `from` and `to` in the audit filters as instants if a local day is wanted. This is a known limit of the design, not a bug to work around: a frontend should send the day the user picked, and show the times it receives in local time.
