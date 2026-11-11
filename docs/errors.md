# Errors

Every failure has the same shape and a stable `code`. A client branches on the **code and the status**, never on the message: the message is for people, and it is in the language of the request (`Accept-Language: ar` or English).

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Validation failed",
  "details": [{ "path": "villaNumber", "message": "Enter between 1 and 50 characters" }],
  "requestId": "0c5f2f4e-6a52-4a6b-9f3a-1c1f7b7a1d10"
}
```

- `details` is present only when there is something to say: one entry per invalid field (`path` is the field, with dots for nested ones, `message` is translated), or `{ "path": "version", "value": 4 }` on a `VERSION_CONFLICT`.
- `requestId` is also the `X-Request-Id` response header. Quote it when reporting a problem: it finds the log lines and the audit entry of the request.
- A `5xx` never carries internals: the message is generic, and the cause is in the log under the request id.
- A `4xx` that no code below names is one of the framework's: a malformed JSON body is `400 BAD_REQUEST`, a body over the limit is `413 PAYLOAD_TOO_LARGE`, an unknown path is `404 NOT_FOUND`.

The tables are checked against the source by `tests/docs/errors.docs.test.ts`: a code that is raised and not listed here, or listed and no longer raised, fails the build.

## Which status means what

| Status | Meaning                                       | What the client does                                                                         |
| ------ | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400    | The request is malformed or breaks a rule     | Show the field messages; do not retry unchanged.                                             |
| 401    | Not signed in, or the token is no good        | `TOKEN_EXPIRED`: refresh and retry once. Anything else: go to the sign-in page.              |
| 403    | Signed in, not allowed                        | Hide or disable the action. Do not retry.                                                    |
| 404    | The thing does not exist (or the path)        | Show "not found"; refresh the list it came from.                                             |
| 409    | The request is fine but the state refuses it  | Read the code: a name taken, a record in use, a stale version, a key still running.          |
| 413    | Too big                                       | Tell the user the limit (a file, a body, an import).                                         |
| 415    | An import file that is not a spreadsheet      | Ask for an `.xlsx`.                                                                          |
| 422    | Understood, and refused on a rule of the data | Show the message: a key reused, a contractor not on the villa, an export over the row limit. |
| 428    | A required header is missing                  | A bug in the client: send `If-Match`.                                                        |
| 429    | Too many requests                             | Wait for `Retry-After` seconds.                                                              |
| 502    | A service behind the API failed               | The reset email could not be sent; try again.                                                |

## Every code

### Request, signing in and access

| Code                       | Status | When                                                                                                                                              |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`              | 400    | A body that is not valid JSON, or another client mistake the framework reports.                                                                   |
| `VALIDATION_ERROR`         | 400    | A field, query parameter or path parameter is invalid. `details` lists each one.                                                                  |
| `INVALID_STORAGE_KEY`      | 400    | A stored file's key is not a safe path (a defence: a client cannot cause it).                                                                     |
| `UNAUTHORIZED`             | 401    | No `Authorization: Bearer` token, or a token that is not valid.                                                                                   |
| `TOKEN_EXPIRED`            | 401    | The access token has expired. Call `POST /auth/refresh`, then repeat the request.                                                                 |
| `INVALID_CREDENTIALS`      | 401    | Wrong email or password. The same answer for an unknown email, so it does not say which was wrong.                                                |
| `INVALID_REFRESH_TOKEN`    | 401    | The refresh cookie is missing, unknown or expired. The cookie is removed; sign in again.                                                          |
| `REFRESH_TOKEN_REUSED`     | 401    | A refresh token that was already used came back (it may have been stolen): every refresh token of the user is revoked. Sign in again.             |
| `FORBIDDEN`                | 403    | The signed-in user does not hold the permission the route needs.                                                                                  |
| `ACCOUNT_INACTIVE`         | 403    | The password is right and the account is not active (a new sign-up waits for an administrator, or the user was deactivated). Also from a refresh. |
| `NOT_FOUND`                | 404    | No such path.                                                                                                                                     |
| `TOO_MANY_REQUESTS`        | 429    | A rate limit was hit (the answer carries `Retry-After`). See [operations.md](operations.md#rate-limits).                                          |
| `PAYLOAD_TOO_LARGE`        | 413    | The JSON body is over `BODY_LIMIT`.                                                                                                               |
| `INTERNAL_ERROR`           | 500    | Anything unexpected. The cause is in the log under the `requestId`.                                                                               |
| `REFRESH_CONFLICT`         | 409    | Two requests rotated the same refresh token at once. The cookie is kept: repeat the call.                                                         |
| `EMAIL_TAKEN`              | 409    | Sign-up, or a user's email, is already registered.                                                                                                |
| `INVALID_CURRENT_PASSWORD` | 400    | `POST /auth/change-password` with a wrong current password.                                                                                       |
| `INVALID_RESET_TOKEN`      | 400    | A reset link that is wrong, used or expired.                                                                                                      |

### Users and permissions

| Code                            | Status | When                                                                                        |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `USER_NOT_FOUND`                | 404    | No such user.                                                                               |
| `ADMIN_ACCOUNT_PROTECTED`       | 403    | Only the administrator can change the administrator account.                                |
| `ADMIN_CANNOT_BE_DEACTIVATED`   | 403    | The administrator cannot be deactivated.                                                    |
| `ADMIN_CANNOT_BE_DELETED`       | 403    | An ADMIN account cannot be deleted.                                                         |
| `CANNOT_DELETE_SELF`            | 403    | A user cannot delete their own account.                                                     |
| `USER_HAS_RECORDS`              | 409    | Deleting a user who created villas or uploaded villa documents: deactivate them instead.    |
| `CANNOT_DEACTIVATE_SELF`        | 403    | A user cannot deactivate their own account.                                                 |
| `ADMIN_PERMISSIONS_IMMUTABLE`   | 403    | An administrator's permissions are implied by the role and cannot be edited.                |
| `CANNOT_MODIFY_OWN_PERMISSIONS` | 403    | A user cannot change their own permissions.                                                 |
| `PERMISSION_ASSIGN_REQUIRED`    | 403    | Creating a user with permissions needs `permissions:assign` as well as `users:create`.      |
| `EMAIL_DELIVERY_FAILED`         | 502    | The password-reset email could not be sent. The user's sessions were signed out; try again. |

### Write safety

| Code                       | Status | When                                                                                           |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `INVALID_IDEMPOTENCY_KEY`  | 400    | The `Idempotency-Key` is not 8 to 255 characters of `A-Z a-z 0-9 . _ : -`.                     |
| `IDEMPOTENCY_KEY_REQUIRED` | 400    | An import without the header.                                                                  |
| `IDEMPOTENCY_KEY_REUSED`   | 422    | The key was already used for a different request.                                              |
| `IDEMPOTENCY_IN_PROGRESS`  | 409    | The first request with this key is still running. Repeat the same request after `Retry-After`. |
| `INVALID_IF_MATCH`         | 400    | `If-Match` is not a version number.                                                            |
| `IF_MATCH_REQUIRED`        | 428    | A route that insists on `If-Match` (none today) without it.                                    |
| `VERSION_CONFLICT`         | 409    | `If-Match` is old: someone else changed the record. `details[0].value` is the current version. |

See [write-safety.md](write-safety.md).

### Reference data

| Code                            | Status | When                                                                                                               |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `AREA_NOT_FOUND`                | 404    | No such area (also: a villa pointing at one).                                                                      |
| `AREA_TAKEN`                    | 409    | An area with this name already exists in the city.                                                                 |
| `AREA_HAS_VILLAS`               | 409    | The area has villas and cannot be deleted.                                                                         |
| `CIVIL_ENGINEER_NOT_FOUND`      | 404    | No such civil engineer.                                                                                            |
| `CIVIL_ENGINEER_INACTIVE`       | 400    | An inactive civil engineer cannot be given to a villa.                                                             |
| `CIVIL_ENGINEER_HAS_VILLAS`     | 409    | The engineer has villas and cannot be deleted.                                                                     |
| `ELECTRICAL_ENGINEER_NOT_FOUND` | 404    | No such electrical engineer.                                                                                       |
| `ELECTRICAL_ENGINEER_INACTIVE`  | 400    | An inactive electrical engineer cannot be given to a villa or a daily report.                                      |
| `ELECTRICAL_ENGINEER_IN_USE`    | 409    | The engineer has villas or daily reports and cannot be deleted.                                                    |
| `CONTRACTOR_NOT_FOUND`          | 404    | No such contractor.                                                                                                |
| `CONTRACTOR_INACTIVE`           | 400    | An inactive contractor cannot be given to a villa, a daily report, an open work, a small work or a labour row.     |
| `CONTRACTOR_HAS_VILLAS`         | 409    | The contractor is linked to villas or records and cannot be deleted.                                               |
| `ELEC_PHASE_NOT_FOUND`          | 404    | No such electrical phase.                                                                                          |
| `ELEC_PHASE_NAME_TAKEN`         | 409    | Another phase has this name.                                                                                       |
| `ELEC_PHASE_IN_USE`             | 409    | A villa has progress above 0 in the phase, or open works are filed under it: deactivate it instead of deleting it. |
| `ELEC_PHASE_INACTIVE`           | 409    | The progress of an inactive phase cannot be changed, and an open work cannot be given an inactive phase.           |
| `ELEC_PHASES_CHANGED`           | 409    | A reorder that does not name every phase exactly once (one was added or deleted meanwhile): reload.                |

### Villas and their records

| Code                                  | Status | When                                                                                                                                |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `VILLA_NOT_FOUND`                     | 404    | No such villa (also: a record pointing at one).                                                                                     |
| `VILLA_NUMBER_TAKEN`                  | 409    | Another villa has this number.                                                                                                      |
| `VILLA_PLOT_TAKEN`                    | 409    | Another villa is on this area, block and plot.                                                                                      |
| `VILLA_HAS_RECORDS`                   | 409    | The villa has open works added by hand, small works, site reports or labour: delete them first. (Daily reports belong to no villa.) |
| `VILLA_ALREADY_MEW_FOLLOW_UP`         | 409    | Putting a villa on MEW follow up that is already on it.                                                                             |
| `VILLA_NOT_MEW_FOLLOW_UP`             | 409    | Taking a villa off MEW follow up that is not on it.                                                                                 |
| `VILLA_ALREADY_MEW_INSPECTION`        | 409    | Putting a villa on MEW inspection that is already on it.                                                                            |
| `VILLA_MEW_NOT_APPROVED`              | 409    | Putting a villa on MEW inspection while its MEW AC state or MEW electricity state is not `APPROVED`.                                |
| `VILLA_NOT_MEW_INSPECTION`            | 409    | Taking a villa off MEW inspection that is not on it.                                                                                |
| `VILLA_ALREADY_MEW_INSPECTION_PASSED` | 409    | Checking a villa as passed MEW inspection when it already is.                                                                       |
| `VILLA_NOT_MEW_INSPECTION_PASSED`     | 409    | Taking back a passed MEW inspection that the villa does not have.                                                                   |
| `CONTRACTOR_NOT_ON_VILLA`             | 422    | An open work or a labour row names a contractor who is not the villa's contractor.                                                  |
| `WORK_ITEM_NOT_FOUND`                 | 404    | No such open work.                                                                                                                  |
| `OPEN_WORK_PHASE_TAKEN`               | 409    | The villa already has an open work for this electrical phase (a villa has one per phase): edit that one instead.                    |
| `WORK_STATUS_PROGRESS_MISMATCH`       | 422    | A status and a progress that disagree (DONE needs 100, NOT_STARTED needs 0, and so on).                                             |
| `DAILY_REPORT_NOT_FOUND`              | 404    | No such daily report.                                                                                                               |
| `DAILY_REPORT_EXISTS`                 | 409    | The contractor already has a daily report for that date.                                                                            |
| `SMALL_WORK_NOT_FOUND`                | 404    | No such small work.                                                                                                                 |
| `SMALL_WORK_DATE_RANGE_INVALID`       | 422    | The end date of a small work is before its start date.                                                                              |
| `NOTIFICATION_NOT_FOUND`              | 404    | No such notification for the caller (someone else's counts as missing).                                                             |
| `SITE_REPORT_NOT_FOUND`               | 404    | No such site report.                                                                                                                |
| `DAILY_LABOUR_NOT_FOUND`              | 404    | No such labour row.                                                                                                                 |
| `DAILY_LABOUR_EXISTS`                 | 409    | The villa already has a labour row for that contractor and date.                                                                    |
| `FACTORY_NOT_FOUND`                   | 404    | No such factory (also: a delivery pointing at one).                                                                                 |
| `FACTORY_TAKEN`                       | 409    | A factory of the same type already has this name (ignoring case).                                                                   |
| `FACTORY_HAS_DELIVERIES`              | 409    | Deleting a factory that has deliveries.                                                                                             |
| `MATERIAL_ITEM_NOT_FOUND`             | 404    | No such catalog material (also: a delivery line or a villa requirement pointing at one).                                            |
| `MATERIAL_ITEM_TAKEN`                 | 409    | The catalog already has a material of the same type with this name (ignoring case).                                                 |
| `MATERIAL_ITEM_IN_USE`                | 409    | Deleting a catalog material that a delivery has, or moving it to the other type.                                                    |
| `MATERIAL_ITEM_WRONG_TYPE`            | 422    | A delivery line whose material is not of the delivery's factory type.                                                               |
| `DELIVERY_NOT_FOUND`                  | 404    | No such material delivery.                                                                                                          |
| `DELIVERY_NOTE_LIMIT`                 | 409    | Adding delivery note files beyond the 10 a delivery can have.                                                                       |
| `DELIVERY_NOTE_NOT_FOUND`             | 404    | Opening or removing the delivery note of a delivery that has none.                                                                  |
| `MAINTENANCE_NOT_FOUND`               | 404    | No such maintenance villa.                                                                                                          |

### Documents

| Code                   | Status | When                                                                          |
| ---------------------- | ------ | ----------------------------------------------------------------------------- |
| `FILE_NOT_FOUND`       | 404    | No such document, or the file is missing from storage.                        |
| `FILE_LINK_INVALID`    | 401    | A signed file link that has expired, was changed, or is for another document. |
| `NO_FILE_PROVIDED`     | 400    | An upload or an import without a file in the `file` field.                    |
| `TOO_MANY_FILES`       | 400    | More than one file in one request.                                            |
| `INVALID_FILE_TYPE`    | 400    | Not a PDF (decided by the file's first bytes, not its name).                  |
| `FILE_TOO_LARGE`       | 413    | The file is over `MAX_UPLOAD_BYTES` (a document), or over 5 MB (an import).   |
| `VILLA_DOCUMENT_LIMIT` | 409    | The villa already holds `MAX_DOCUMENTS_PER_VILLA` documents.                  |
| `AUDIT_LOG_NOT_FOUND`  | 404    | No such audit entry.                                                          |

### Exports and imports

| Code                      | Status | When                                                                                                                               |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `EXPORT_TOO_LARGE`        | 422    | The filters match more than 10,000 records. Narrow them.                                                                           |
| `UNSUPPORTED_FILE_TYPE`   | 415    | The upload is not an `.xlsx` (by its name and its first bytes).                                                                    |
| `IMPORT_FILE_UNREADABLE`  | 400    | The file cannot be read as a spreadsheet: it is damaged, encrypted, or unpacks to more than the limits allow.                      |
| `IMPORT_HEADER_MISMATCH`  | 400    | The header row does not match the template (a missing, repeated or unknown column; `details` names them).                          |
| `IMPORT_TOO_MANY_ROWS`    | 422    | More than 2,000 data rows.                                                                                                         |
| `IMPORT_TOO_MANY_COLUMNS` | 422    | More than 30 columns.                                                                                                              |
| `IMPORT_CELL_TOO_LONG`    | 422    | A cell holds more characters than its column allows (`details` names the cell).                                                    |
| `IMPORT_NO_ROWS`          | 422    | The file has a header and no data rows.                                                                                            |
| `FILE_ALREADY_IMPORTED`   | 409    | The same file (by content) was imported before. Nothing is saved twice.                                                            |
| `IMPORT_DATA_CHANGED`     | 409    | A villa, an area, an engineer or a contractor changed while the file was being imported. Nothing was saved: upload the file again. |

A problem in the **rows** of an import file is not an error response with a `code`: the body is the import report (`{ "data": { "ok": false, "errors": [...] } }`), with status `422` for a real import (nothing is saved) and `200` for a dry run (which always reports). The codes of the row errors are in [imports-exports.md](imports-exports.md#row-error-codes).

## Validation messages

A `VALIDATION_ERROR` message is chosen by the field's rule, so it can be shown beside the field as it is. One of them is deliberate: `GET /daily-reports?villaId=...` answers `400 VALIDATION_ERROR` on the path `villaId` ("A daily report no longer belongs to a villa. Filter by contractorId or preparedByEngineerId instead"), because a daily report has no villa; it is refused rather than ignored so that a page still sending it cannot show every report as the villa's. The messages live in `src/core/i18n/locales/en.json` and `ar.json` (the two files have the same keys; a test checks it). Do not parse a message: use `path` to find the field.
