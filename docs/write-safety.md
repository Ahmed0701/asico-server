# Write safety

Two things protect a write from the failures that are normal on a real network: **idempotency keys** (a request that is sent twice runs once) and **versions** (a change that was made on stale data is refused). This page is the contract for the frontend, and the rules a future money endpoint has to follow. The route-by-route list (which route takes an `Idempotency-Key`, which an `If-Match`) is in the tables of [api.md](api.md), checked against the routers by a test.

## 1. Idempotency-Key

Send `Idempotency-Key: <key>` on a write that must not run twice: a double click, a retry after a timeout or a dropped connection.

**Covered today.** Every create (`POST` of a villa, an area, a civil or electrical engineer, an electrical phase, a contractor, a user, an open work, a daily report, a small work, a site report, a labour row), the changes that are not an edit of one record (the reorder `PUT /elec-phases/order`, a phase's progress, putting a villa on a MEW list and taking it off, a user's password reset), and the document upload. For these the header is **optional**: send it, and a retry cannot run twice.

**Required.** The eight imports (`POST .../import` of villas, contractors, daily labour, daily reports, material deliveries, open works, site reports and small works) refuse a request without the header (`400 IDEMPOTENCY_KEY_REQUIRED`): a file imported twice by a double click or a retry would otherwise be hard to notice. The key of an import is tied to the file's content and to whether it is a dry run (not to the file's name): the same key with another file, or with `dryRun` switched, is `422 IDEMPOTENCY_KEY_REUSED`. On top of the key, a file that an earlier import of the same kind already saved (the same bytes, by hash) is refused with `409 FILE_ALREADY_IMPORTED`, whatever key it comes with. A dry run (`?dryRun=true`) writes nothing and does not count as an import, so the same file can be imported afterwards, with a new key.

Not covered, on purpose: edits (`PATCH`, `DELETE`: repeating them is harmless, and `If-Match` guards them), reads, and exports (a read).

Never on `/auth/*`: those carry passwords and tokens, and nothing there is stored.

**The key.** 8 to 255 characters of `A-Z a-z 0-9 . _ : -`; a UUID v4 is the right choice. Make **one key per user action** (when the form is opened or the button is first pressed), and **reuse it for every retry of that action**. Never reuse a key for a different action, and never derive it from the data. Keys are per user: another user's identical key is another request.

**What the server does**

| Situation                                                                    | Answer                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| First time                                                                   | Runs as usual.                                                                                                                             |
| Same key, same request, already finished                                     | The stored response, with the same status and body, and `Idempotent-Replayed: true`. Nothing runs, so nothing is audited or emailed again. |
| Same key, a different request (other body, other URL or query, another file) | `422 IDEMPOTENCY_KEY_REUSED`.                                                                                                              |
| Same key while the first request is still running                            | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. Wait and send the same request again: it will be a replay.                            |
| Key not valid                                                                | `400 INVALID_IDEMPOTENCY_KEY`.                                                                                                             |
| Key missing on a route that requires one (an import)                         | `400 IDEMPOTENCY_KEY_REQUIRED`.                                                                                                            |

**What is kept.** Only a successful (2xx) response, for 24 hours. A `4xx` or `5xx` gives the key back, so after a failure the same key can be used again (after fixing the request, for a 4xx). A request that never finished (the server died) holds its key for 2 minutes at most. The request itself is never stored, only an HMAC of it; the response body is stored, so a replay returns what the first answer said (the same status and the same JSON content: the order of the keys inside an object is not preserved), even if the record has changed since.

**Frontend checklist**

- Generate the key once per action; keep it until the action succeeds or the user gives up.
- Retry on network errors, timeouts, `5xx` and `409 IDEMPOTENCY_IN_PROGRESS` with the **same** key and the **same** request. Do not retry other `4xx`.
- Treat a replayed answer as the answer: it is exactly the first response.
- Read `Idempotent-Replayed` and `Retry-After` from a browser on another origin: they are exposed (`Access-Control-Expose-Headers`, with `ETag`, `X-Request-Id` and `Content-Disposition`).

**Housekeeping.** Expired rows are never read as valid (a colliding key reclaims its row), but they are not removed on their own. Delete them from time to time:

```bash
npm run idempotency:purge
```

or, in SQL, `DELETE FROM "IdempotencyKey" WHERE "expiresAt" < now();`. It is safe at any time and as often as you like. There is no scheduler yet: run it daily from cron, a scheduled task or a CI job. A few thousand rows cost nothing, so there is no urgency.

**For the next endpoint.** Mount the middleware after authentication, the permission check and validation:

```ts
router.post("/things", ...can(PERMISSIONS.THINGS_CREATE), validate(schema), idempotent(), controller.create);
router.post("/payments", ..., validate(schema), idempotent({ required: true }), controller.pay);
```

`required: true` refuses the request without the header (`400 IDEMPOTENCY_KEY_REQUIRED`). Use it for anything that moves money.

## 2. Versions and If-Match

`User`, `Villa`, `Contractor`, `CivilEngineer`, `ElectricalEngineer`, `ElecPhase`, `Area`, `WorkItem` (an open work), `DailyReport`, `DailySmallWork`, `SiteReport` and `DailyLabour` rows have an integer `version`. It starts at 1 and **every write to the row adds 1**. It is in the item (`"version": 3`) of every response that returns the record, and a single item (`GET /:id`, and the response of its `PATCH`) also carries it as `ETag: "3"`.

**Use it.** Send the version you read as `If-Match` on the change (`3`, `"3"` and `W/"3"` are all read):

```
PATCH /api/v1/contractors/4b2…
If-Match: 3
```

| Situation                                     | Answer                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `If-Match` matches the current version        | The change is made, `version` becomes 4.                                                                                                                             |
| `If-Match` is old (someone else changed it)   | `409 VERSION_CONFLICT`, nothing changed. `details: [{ "path": "version", "value": <current> }]`. Reload the record, show the user what changed, and let them decide. |
| `If-Match` absent, or `*`                     | Goes through (optional for now). The version still goes up.                                                                                                          |
| `If-Match` is not a version number            | `400 INVALID_IF_MATCH`.                                                                                                                                              |
| Route requires it and it is absent (none yet) | `428 IF_MATCH_REQUIRED`.                                                                                                                                             |

**The ETag is for `If-Match`, never for caching.** The version moves only when that row is written, but a detail also holds what other tables decide: a villa's phases and progress (a phase has its own version, and changing it does not move the villa's), a contractor's, civil engineer's, electrical engineer's or area's `villaCount`, the names of the villa, contractor or other records a report or work item points to, and an open work's `overdue`, which follows the clock. A cache that trusted the ETag would show the old body. So every response that carries a version ETag (the `GET /:id`, the `PATCH` and the actions of the records listed above, and a phase's progress) is sent with `Cache-Control: private, no-store`, and the server **never answers `304`** to `If-None-Match` or `If-Modified-Since` on them: it answers `200` with the current body, even to a browser that cached the page before this rule. The `ETag` header and the `version` field are unchanged (`ETag: "3"` is still the version, for `If-Match`). The lists set no version ETag; they get the server's own tag computed from the body, so a `304` there always means the body is the same. It is one helper, `setVersionHeaders` in `src/core/concurrency/version.ts`, and a test fails if a module sets an `ETag` by hand.

It applies to `PATCH` and `DELETE` of every one of those records, to `PATCH /users/:id/activate` and `/deactivate`, to putting a villa on a MEW list and taking it off, and to a phase's progress (the version of the progress row, which the villa's detail lists as `version` of each phase). A change to a villa (its contractor, dates or any other field) moves the villa's version. It is optional everywhere today: a route that insists on it answers `428 IF_MATCH_REQUIRED`, and none does yet.

**A reorder has no `If-Match`.** `PUT /elec-phases/order` changes the places of many phases at once, so it carries no version of its own. Instead the list you send must name **every** phase exactly once: if a phase was added or deleted since you loaded the page, the answer is `409 ELEC_PHASES_CHANGED` and nothing moves (reload and try again). Each phase that does move gets `version + 1`; the phases that stay put do not. Two reorders at the same time take turns, and the later one wins.

**How it is made safe.** The row is locked (`SELECT … FOR UPDATE`) for the whole transaction, the version is compared, and the write is `UPDATE … WHERE id = ? AND version = ?` with the row count checked; two simultaneous changes with the same version leave exactly one winner, and the audit entry of each records exactly what its write replaced. The audit entry is written in the same transaction, so a failed audit rolls the change (and the version) back.

**Frontend checklist**

- Keep the `version` of what the form was filled from; send it as `If-Match` on save.
- On `VERSION_CONFLICT`, refetch, show the difference, and retry with the new version only after the user agrees. Never retry automatically with the new version: that is the overwrite this exists to prevent.
- Version and idempotency key are independent: a retry of the same save keeps its key **and** its `If-Match`.

## 3. Money endpoints (rules for later)

Nothing in this system moves money yet. When something does, build it like this from the first line, because none of it can be retrofitted safely.

1. **Integer minor units.** An amount is an integer count of the currency's smallest unit (`12550` for 125.50 EGP or 12.550 KWD: the number of decimals is the currency's own), in a `BIGINT` column, with the currency code next to it (`"EGP"`, ISO 4217). Never a float, never a decimal string in storage, never `Number` arithmetic on amounts that may exceed 2^53. The API sends and receives `{ "amount": 12550, "currency": "EGP" }`; formatting for people happens at the edge only. Different currencies are never added together.
2. **Append-only ledger.** Every movement is a new row in a ledger table: id, account, signed amount, currency, a reference to what caused it, who, when. No `UPDATE`, no `DELETE`: enforce it in the database the way `AuditLog` is (a trigger that rejects both), not only in code.
3. **Reversal entries, no in-place edits.** A mistake is corrected by a new entry that reverses the old one (same amount, opposite sign, `reverses_id` pointing at it) followed by the correct entry. The history shows both. A transfer is one transaction with two entries that sum to zero.
4. **Balances are derived**, not stored: a sum over the ledger (or a materialised view or snapshot table that can always be rebuilt from it). If a stored balance exists for speed, it is a cache with a version, updated in the same transaction as the entry.
5. **`Idempotency-Key` required** (`idempotent({ required: true })`) on every endpoint that creates an entry, and the entry's own reference column carries a unique constraint on (account, client reference) as the last line of defence.
6. **One transaction per operation**: the entries, the audit row and the idempotency result commit together or not at all. `REPEATABLE READ` or row locks on the accounts involved, always taken in the same order to avoid deadlocks.
7. **`If-Match` required** (`ifMatch({ required: true })`) on anything that edits a record that holds configuration for money (rates, limits).
8. **No secrets or card data in the audit log, the idempotency table or the logs.** Payment providers' tokens only.
