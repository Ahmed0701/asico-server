# Imports and exports

Twelve exports (a workbook or a PDF of what a list shows) and seven imports (a workbook of new records). The routes and their access are in [api.md](api.md); the error codes in [errors.md](errors.md). A test (`tests/docs/imports-exports.docs.test.ts`) makes every export and every template with the real code and fails when the columns, the required marks, the limits or the row error codes here are not what it writes.

## Exports

An export is a `GET` on the list's path plus `/export`, with a `format`:

```
GET /api/v1/daily-reports/export?format=xlsx&contractorId=…&reportFrom=2026-01-01
```

- **`format`** is `xlsx` or `pdf`, and is required (`400 VALIDATION_ERROR` otherwise).
- **The filters and the sort are those of the list** (see [frontend-contract.md](frontend-contract.md)), checked by the list's own schema, so an export of "what is on screen" is the same query without the paging. `page` and `limit` are refused (400): an export is never a page.
- **At most 10,000 records.** More answers `422 EXPORT_TOO_LARGE` before any file is made: narrow the filters.
- **The file** is named `elecico-<file>-<YYYY-MM-DD>.<format>` (the day is the UTC day), sent as an attachment with `Cache-Control: private, no-store`.
- **The file is in English**, whatever `Accept-Language` says (`Content-Language: en`); error messages still follow the request. The audit export writes the action and entity labels, not their codes.
- **Dates and times are UTC.** A column of times is headed `(UTC)`. A text column stays text in a workbook, so a phone number or a villa number keeps its leading zeros. Column widths fit the content, in both formats; a PDF lists the filters that were applied above the table.
- **Every export writes an audit entry** (`export.<name>`) before the file is made, so it leaves a trace whatever happens to the download. It holds the format, the filters and the number of records, never the rows.
- **Rate limit:** 10 exports a minute per user (`429 TOO_MANY_REQUESTS` beyond that).
- **Who may export:** the `:export` permission of the resource, except the areas, the contractors and the engineers (`:read`) and the contractor's summary (`contractors:summary`). See [permissions.md](permissions.md).

The twelve exports. For the seven resources that have an import (see [Exporting and importing again](#exporting-and-importing-again)) a workbook has **the columns of the import first, in its order, and then the columns the import only reads past**: the same titles, in the same order, with the same cell formats (a budget or a progress is a number, a date is a date). A PDF keeps its own columns, as before.

| Route                                 | Permission                  | File                   | Sheet                  | Columns                                                                                                                                                          |
| ------------------------------------- | --------------------------- | ---------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /villas/export`                  | `villas:export`             | `villas`               | `Villas`               | Villa Number, Owner Name, Area, Block, Plot, Contractor, Electrical Engineer, Civil Engineer, Start Date, Target Date, Budget, Currency, Progress, Created (UTC) |
| `GET /open-works/export`              | `open-works:export`         | `open-works`           | `Open Works`           | Villa Number, Electrical Phase, Status, Priority, Progress, Contractor, Start Date, End Date, Location, Overdue                                                  |
| `GET /daily-reports/export`           | `daily-reports:export`      | `daily-reports`        | `Daily Reports`        | Report Date, Contractor, Electrical Engineer, Weather, Workers, Notes                                                                                            |
| `GET /small-works/export`             | `small-works:export`        | `small-works`          | `Daily Small Works`    | Villa Number, Start Date, End Date, Description, Contractor, Status, Location                                                                                    |
| `GET /site-reports/export`            | `site-reports:export`       | `site-reports`         | `Site Reports`         | Villa Number, Title, Visit Date, Inspector, Type, Rating, Findings, Recommendations, Location                                                                    |
| `GET /daily-labour/export`            | `daily-labour:export`       | `daily-labour`         | `Daily Labour`         | Villa Number, Labour Date, Labour Count, Contractor, Notes, Location                                                                                             |
| `GET /contractors/export`             | `contractors:read`          | `contractors`          | `Contractors`          | Name, Phone, Email, Status, Villas, Created (UTC)                                                                                                                |
| `GET /civil-engineers/export`         | `civil-engineers:read`      | `civil-engineers`      | `Civil Engineers`      | Name, Phone, Email, Status, Villas, Created (UTC)                                                                                                                |
| `GET /electrical-engineers/export`    | `electrical-engineers:read` | `electrical-engineers` | `Electrical Engineers` | Name, Phone, Email, Status, Villas, Created (UTC)                                                                                                                |
| `GET /areas/export`                   | `areas:read`                | `areas`                | `Areas`                | Name, City, Villas, Created (UTC)                                                                                                                                |
| `GET /contractors/:id/summary/export` | `contractors:summary`       | `contractor-summary`   | `Contractor Summary`   | Villa Number, Area, Block, Plot, Start Date, Target Date                                                                                                         |
| `GET /audit-logs/export`              | `audit:read`                | `audit-logs`           | `Audit Log`            | Time (UTC), Actor, Actor Email, Action, Entity, Entity ID, IP, User Agent, Request ID                                                                            |

## Imports

Seven lists can be filled from a workbook: the villas, the contractors, the open works, the daily reports, the small works, the site reports and the daily labour. Everything else is entered one record at a time.

### The flow

1. **Download the template:** `GET /<resource>/import/template` gives an `.xlsx` with the header, an example row, and an Instructions sheet that says what each column takes, and [dropdowns](#dropdowns-in-the-template) on the columns that name a record or take one of a fixed list. The text on that sheet is the text of the tables below.
2. **Check the file without saving:** `POST /<resource>/import?dryRun=true` with the file as multipart field `file`. It always answers `200` with the report.
3. **Import it:** the same request without `dryRun`. It answers `201` and the records are saved, or `422` with the report and **nothing saved**: a file is imported whole or not at all.

Every import takes an `Idempotency-Key` header (**required**). The key is remembered with the content of the file and `dryRun`, not its name: repeating a request gives the first answer again, and the same file imported twice under two keys answers `409 FILE_ALREADY_IMPORTED`. A villa, an area, an engineer or a contractor that changed while the import was running, so that a row is no longer valid, answers `409 IMPORT_DATA_CHANGED` and saves nothing: check the file again. The rate limit is 10 imports a minute per user.

### Dropdowns in the template

The template has dropdowns (list data validation) so that people pick a reference value instead of typing it. **A dropdown helps; it does not decide.** A pasted value skips it, a file made some other way has none, and the server checks every row of every file as before: a value the import does not accept is still a row error.

| Template      | Columns with a dropdown                                                   |
| ------------- | ------------------------------------------------------------------------- |
| Villas        | `Area`, `Civil Engineer`, `Electrical Engineer`, `Contractor`, `Currency` |
| Contractors   | `Status`                                                                  |
| Open works    | `Villa Number`, `Electrical Phase`, `Status`, `Priority`, `Contractor`    |
| Daily reports | `Contractor`, `Electrical Engineer`, `Weather`                            |
| Small works   | `Villa Number`, `Contractor`, `Status`                                    |
| Site reports  | `Villa Number`, `Type`, `Rating` (1 to 5)                                 |
| Daily labour  | `Villa Number`, `Contractor`                                              |

- **The URL, the permission and the file name do not change.** The template is built when it is downloaded, from the data of that moment, so download it again after areas, people or villas are added.
- **Where the choices are.** A hidden sheet, `Lists`, the last of the workbook (`hidden`, which a person can unhide; not `veryHidden`), with one column per dropdown. The data sheet stays first, and **only the first sheet is read**: a file that still has its `Lists` sheet imports exactly as one without. Each dropdown is one rule over rows 2 to 2,001 (the most rows an import reads); it shows a short prompt and **stops** a value that is not in the list. The design, the column widths (up to 60) and the Instructions sheet are the same as before.
- **The text of a choice is what the import resolves to exactly one record, and what the villas export writes for it** (one rule for both, in `shared/import/reference-names.ts`): an area is its name, or `Name, City` when another area has that name; a contractor or an engineer is its name, or its phone (as stored) when another party of the same kind has that name; a villa is its number as stored; an electrical phase is its name. Only **active** parties and phases are listed (areas have no status). Names are compared the way the import compares them (ignoring case and extra spaces), and a switched-off party counts when names are compared, so the choice is always one the import finds. A record the import could not tell apart from another, even by this text (two areas with the same name and city, two parties with the same name and phone), has no choice.
- **Order.** Alphabetical (a fixed English collation: Arabic names come after Latin ones), and villa numbers in natural order (`V-2` before `V-10`). A choice is written as plain text, with commas, quotes and Arabic as they are.
- **A contractor on a villa's own record.** The dropdown lists every active contractor. The open works and daily labour imports still accept only the villa's own contractor and answer `CONTRACTOR_NOT_ON_VILLA` for another: the dropdown does not narrow by villa. (A daily report and a small work take any active contractor.)
- **More than 20,000 choices.** A list is cut at 20,000 choices (a list that left out a valid value would refuse it). A column with more shows the first 20,000, **warns instead of stopping** (the value can be typed and kept), and its line on the Instructions sheet says so.
- **Who sees what.** The template needs `<resource>:import`, not the read permission of the lists it points to. So whoever may import can read, in the dropdowns, the **names of the active areas, civil engineers, electrical engineers, contractors and electrical phases, the phone of a party whose name is shared, and every villa number**. Nothing else (no inactive record, e-mail, budget or address).
- **Exports have no dropdowns.** They are read-only reports, written as a stream; an exported file is imported through the same checks.

### The file

- An `.xlsx` of at most 5 MB. Only the first sheet is read. Row 1 is the header, and every other row is a record; blank rows are skipped.
- **The header names must be exactly the template's** (which are the titles the export uses), each once, in any order, with two additions: the **columns of an export that the import only reads past** (listed for each import below) may be there, and are ignored; and the villas' **`Currency` column may be left out**. No other column is allowed. A mismatch answers `400 IMPORT_HEADER_MISMATCH`, and its `details` list every column that is missing, repeated or unknown, so one upload shows everything to fix.
- A text column wants text: a number, a date or a true/false typed into one is refused (`NOT_TEXT`) rather than turned into text, because a phone number typed into a General cell has already lost its leading zero. Format such a column as Text. (The villa number of every import that has one is the exception, and so are the owner name, block and plot of the villas: a whole number is read as text there, see [Villas](#villas).)
- A text that an export wrote with a leading apostrophe (`'+20 100 123 4567`, `'=…`) is read without it. The export adds the apostrophe to a text that starts with `=`, `+`, `-`, `@`, a tab or a return, so that a spreadsheet does not run it as a formula; the import takes it off, one apostrophe, so the text comes back as it was.
- A date is written `YYYY-MM-DD` or is a date cell (read as its UTC day). A formula is read as the value it last had.
- A reference (a villa, an area, a contractor, an engineer) is matched by its text ignoring case and extra spaces; a contractor or an engineer is also matched by phone. A reference is never created or guessed. A villa number is matched **exactly as it is stored first**, and only then ignoring case and spaces: if two villas fit loosely and none exactly (`V-1` and `v-1` are both stored and the cell says `V -1`), the row is `AMBIGUOUS_REFERENCE`.
- The file-level problems (a wrong type, unreadable, too big, too many rows or columns, a cell too long, no rows) are error responses with a `code`: see [errors.md](errors.md).

### Limits

<!-- limits -->

| Limit                          | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| Data rows                      | 2,000                                                      |
| Columns                        | 30                                                         |
| Characters in a cell           | 2,000                                                      |
| Characters in a long-text cell | 5,000 (the columns marked long: the API's own text fields) |
| File size                      | 5 MB                                                       |
| Errors listed in a report      | 200 (`truncated` says when more were found)                |
| Records in an export           | 10,000                                                     |

### The report

Every answer to an import, saved or not, is `{ "data": <report> }`:

```json
{
  "data": {
    "ok": false,
    "total": 120,
    "imported": 0,
    "skipped": 0,
    "errors": [
      {
        "row": 14,
        "column": "weather",
        "code": "INVALID_OPTION",
        "message": "This is not one of the allowed values",
        "value": "Foggy"
      }
    ],
    "truncated": false
  }
}
```

`total` is the number of data rows in the file; `imported` is the number saved (0 for a dry run and for a file with errors); `skipped` is the number of rows left out on purpose, which are not errors and are not saved (only the open works import skips: the rows of the automatic items an export writes, see [Open works](#open-works); it is `0` everywhere else, and `total` counts them). A file whose rows are all skipped answers `201` with `imported: 0` and is recorded like any other, so the same file is not read twice. `row` is the row number in the spreadsheet (the header is row 1); `value` is what was typed, shortened to 200 characters, or `null` for an empty or unreadable cell. Errors are sorted by row and then by the column's place in the template. `message` is in the language of the request; branch on `code`.

### Row error codes

| Row error                 | Meaning                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REQUIRED`                | The column is required and the cell is empty.                                                                                                                                              |
| `INVALID_VALUE`           | The value breaks the column's rule: too long, out of range, not a date, not a whole number, a date in the future.                                                                          |
| `NOT_TEXT`                | A number, a date or a true/false was typed into a text column.                                                                                                                             |
| `INVALID_OPTION`          | The text is not one of the column's options.                                                                                                                                               |
| `UNREADABLE_CELL`         | A formula with no stored value, or a cell holding an error such as `#DIV/0!`.                                                                                                              |
| `REFERENCE_NOT_FOUND`     | No villa, area, engineer or contractor matches the text.                                                                                                                                   |
| `AMBIGUOUS_REFERENCE`     | The text matches more than one record: two areas of one name (write `Name, City`), two people with the name or the phone, or a villa number that fits two villas loosely and none exactly. |
| `CONTRACTOR_NOT_ON_VILLA` | The contractor exists but is not the contractor of that villa. A villa's records name its own contractor only.                                                                             |
| `DUPLICATE_IN_FILE`       | The same record appeared earlier in the file. The first row stands, every later one is the error.                                                                                          |
| `DUPLICATE_EXISTING`      | The record is already in the system.                                                                                                                                                       |

What makes a record "the same" differs by import:

| Import        | Same record                                                       | Checked by                                                                 |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Villas        | villa number (ignoring case and spaces); and area, block and plot | `DUPLICATE_IN_FILE`, `DUPLICATE_EXISTING`, on `Villa Number` and on `Plot` |
| Contractors   | name and phone                                                    | `DUPLICATE_IN_FILE`, `DUPLICATE_EXISTING`                                  |
| Open works    | none (the same row may be written twice)                          | only the file itself: `FILE_ALREADY_IMPORTED`                              |
| Daily reports | contractor and report date                                        | `DUPLICATE_IN_FILE`, `DUPLICATE_EXISTING`, on `Report Date`                |
| Daily labour  | villa, contractor and labour date                                 | `DUPLICATE_IN_FILE`, `DUPLICATE_EXISTING`                                  |
| Small works   | none (the same text may be written twice)                         | only the file itself: `FILE_ALREADY_IMPORTED`                              |
| Site reports  | none                                                              | only the file itself: `FILE_ALREADY_IMPORTED`                              |

### The columns of each import

### Contractors

`POST /contractors/import` and `GET /contractors/import/template`, both `contractors:import`.

<!-- import: contractors -->

| Column   | Required | What it takes                                                                   |
| -------- | -------- | ------------------------------------------------------------------------------- |
| `Name`   | Yes      | The contractor's name, up to 100 characters.                                    |
| `Phone`  | Yes      | 5 to 20 characters: digits, spaces and dashes, with an optional + at the start. |
| `Email`  | No       | A contact email address. Leave it empty if there is none.                       |
| `Status` | No       | Leave it empty for Active.                                                      |

An export also has `Villas` (how many villas the contractor has) and `Created (UTC)`. They are read past and ignored, whatever they hold. The template does not have them.

### Daily labour

`POST /daily-labour/import` and `GET /daily-labour/import/template`, both `daily-labour:import`.

<!-- import: daily-labour -->

| Column         | Required | What it takes                                                                                                                |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Villa Number` | Yes      | The villa number, exactly as it is in the system.                                                                            |
| `Labour Date`  | Yes      | The day, written YYYY-MM-DD, or a date cell. A villa has one row per contractor per day. Tomorrow is the latest day allowed. |
| `Labour Count` | Yes      | How many workers the contractor had on site: a whole number from 0 to 100,000.                                               |
| `Contractor`   | Yes      | The villa's own contractor, by name or by phone. Another contractor is refused.                                              |
| `Notes`        | No       | A note on the day, up to 500 characters. Leave it empty if there is none.                                                    |

An export also has `Location` (the villa's area, block and plot). It is read past and ignored: the villa is found by `Villa Number`. The template does not have it.

### Daily reports

`POST /daily-reports/import` and `GET /daily-reports/import/template`, both `daily-reports:import`. A daily report belongs to a **contractor** and to the **electrical engineer** who prepared it, not to a villa: the file has no `Villa Number`.

<!-- import: daily-reports -->

| Column                | Required | What it takes                                                                                                                       |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Report Date`         | Yes      | The day of the report, written YYYY-MM-DD, or a date cell. A contractor has one report per day. Tomorrow is the latest day allowed. |
| `Contractor`          | Yes      | The contractor the report is about, by name or by phone. Only an active contractor.                                                 |
| `Electrical Engineer` | Yes      | The electrical engineer who prepared the report, by name or by phone. Only an active engineer.                                      |
| `Weather`             | Yes      | The weather that day.                                                                                                               |
| `Workers`             | Yes      | How many workers were on site: a whole number from 0 to 100,000.                                                                    |
| `Notes`               | No       | Anything worth noting about that day, up to 5,000 characters. Leave it empty if there is nothing.                                   |

- **The same report** is the same contractor on the same date: a second row in the file is `DUPLICATE_IN_FILE` and a report the contractor already has is `DUPLICATE_EXISTING`, both on `Report Date`.
- **Contractor and engineer** are found by name (ignoring case and extra spaces) or by phone (ignoring spaces and dashes). Two records the text names are `AMBIGUOUS_REFERENCE`; none is `REFERENCE_NOT_FOUND`; an inactive one is `INVALID_VALUE`. Nothing is created. If one is switched off between the check and the save, the whole file is refused with `IMPORT_DATA_CHANGED`.
- **The old columns are gone.** A file with `Villa Number`, `Work Done`, `Issues` or `Prepared By` (the headers before this change) is `IMPORT_HEADER_MISMATCH`: use `Contractor` and `Electrical Engineer`, and put what was in `Issues` into `Notes`. The export is the template with the data in it and has no informational column.

### Open works

`POST /open-works/import` and `GET /open-works/import/template`, both `open-works:import`.

<!-- import: open-works -->

| Column             | Required | What it takes                                                                                                                                              |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Villa Number`     | Yes      | The villa number, exactly as it is in the system.                                                                                                          |
| `Electrical Phase` | Yes      | The electrical phase the work is filed under, by its name, exactly as the electrical phases page shows it. Only an active phase.                           |
| `Status`           | No       | Leave it empty to let the progress decide: Not started at 0, In progress from 1 to 99, Done at 100. Not started needs a progress of 0, and Done needs 100. |
| `Priority`         | No       | Leave it empty for Medium.                                                                                                                                 |
| `Progress`         | No       | A whole number from 0 to 100. Leave it empty for 0 (100 when the status is Done).                                                                          |
| `Contractor`       | No       | The villa's own contractor, by name or by phone. Leave it empty for none. Another contractor is refused.                                                   |
| `Start Date`       | No       | A day written YYYY-MM-DD, or a date cell. Leave it empty if it is not known.                                                                               |
| `End Date`         | No       | A day written YYYY-MM-DD, or a date cell, not before the start date.                                                                                       |

- **One open work per villa and electrical phase.** The same villa and phase twice in the file is `DUPLICATE_IN_FILE` on `Electrical Phase` (the first row stands), and a villa and phase that already have an open work is `DUPLICATE_EXISTING`. Every row is saved as an open work added by hand.
- **The phase** is found by name (ignoring case and extra spaces). None is `REFERENCE_NOT_FOUND` on `Electrical Phase`; an inactive phase is `INVALID_VALUE`. If it is switched off between the check and the save, the whole file is refused with `IMPORT_DATA_CHANGED`.
- **The old columns are gone.** A file with `Title` or `Work Phase` (the headers before this change) is `IMPORT_HEADER_MISMATCH`: use `Electrical Phase` instead.

An export also has `Location` and `Overdue`. They are read past and ignored. The template has neither. A file exported before the automatic open works were removed has a `Source` column, which is not a column any more (`IMPORT_HEADER_MISMATCH`): export it again.

### Site reports

`POST /site-reports/import` and `GET /site-reports/import/template`, both `site-reports:import`.

<!-- import: site-reports -->

| Column            | Required | What it takes                                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------------------------- |
| `Villa Number`    | Yes      | The villa number, exactly as it is in the system.                                             |
| `Title`           | Yes      | What the visit was about, up to 150 characters.                                               |
| `Visit Date`      | Yes      | The day of the visit, written YYYY-MM-DD, or a date cell. Tomorrow is the latest day allowed. |
| `Inspector`       | Yes      | Who made the visit, up to 100 characters.                                                     |
| `Type`            | Yes      | The kind of visit.                                                                            |
| `Rating`          | Yes      | The rating of the visit: a whole number from 1 to 5.                                          |
| `Findings`        | Yes      | What was found, up to 5,000 characters.                                                       |
| `Recommendations` | No       | What should be done, up to 5,000 characters. Leave it empty if there is nothing to add.       |

An export also has `Location` (the villa's area, block and plot). It is read past and ignored: the villa is found by `Villa Number`. The template does not have it.

### Small works

`POST /small-works/import` and `GET /small-works/import/template`, both `small-works:import`.

<!-- import: small-works -->

| Column         | Required | What it takes                                                                                                                                                |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Villa Number` | Yes      | The villa number, exactly as it is in the system.                                                                                                            |
| `Start Date`   | Yes      | The first day of the work, written YYYY-MM-DD, or a date cell. Within 10 years of today.                                                                     |
| `End Date`     | Yes      | The last day of the work (the deadline is the end of this day), written YYYY-MM-DD, or a date cell. Not before the start date, and within 10 years of today. |
| `Description`  | Yes      | What is to be done, up to 500 characters.                                                                                                                    |
| `Contractor`   | Yes      | An existing, **active** contractor, by name or by phone. Any contractor: it does not have to be the villa's own.                                             |
| `Status`       | No       | Leave it empty for Pending.                                                                                                                                  |

How the small works differ from the other files:

- **The dates.** Both are required. An end date before the start date is `INVALID_VALUE` on the `End Date` column; a date more than 10 years from today is `INVALID_VALUE` on its own column. A date in the future is fine: the dates are planned. Overdue and due soon are not columns: they are worked out from the end date, the status and the clock, so an export has no such column and a file does not need one.
- **The contractor** is found by name (ignoring case and extra spaces) or by phone (ignoring spaces and dashes). Two records that the text names, such as two of one name, are `AMBIGUOUS_REFERENCE` and are never guessed (the dropdown then offers them by phone); none is `REFERENCE_NOT_FOUND`; an inactive one is `INVALID_VALUE`. Nothing is created: add the contractor first. If a contractor is switched off between the check and the save, the whole file is refused with `IMPORT_DATA_CHANGED`.
- **The old columns are gone.** A file with `Work Date` or `Done By` is `IMPORT_HEADER_MISMATCH`: add `Start Date`, `End Date` and `Contractor`. A file with `Quantity` or `Unit` (the small works have no quantity any more) is `IMPORT_HEADER_MISMATCH` too: remove the two columns.

An export also has `Location` (the villa's area, block and plot). It is read past and ignored: the villa is found by `Villa Number`. The template does not have it.

### Villas

`POST /villas/import` and `GET /villas/import/template`, both `villas:import`.

<!-- import: villas -->

| Column                | Required | What it takes                                                                                                                                                                                                                                            |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Villa Number`        | Yes      | The villa's number, up to 50 characters. Two villas cannot share a number, in any case.                                                                                                                                                                  |
| `Owner Name`          | No       | The owner, up to 120 characters. Leave it empty if there is none.                                                                                                                                                                                        |
| `Area`                | Yes      | The name of an existing area. If two areas have the same name, write the name and the city: Name, City.                                                                                                                                                  |
| `Block`               | Yes      | The block, up to 50 characters.                                                                                                                                                                                                                          |
| `Plot`                | Yes      | The plot, up to 50 characters. Two villas cannot share an area, a block and a plot.                                                                                                                                                                      |
| `Contractor`          | No       | An existing, active contractor, by name or by phone. Leave it empty if there is none yet.                                                                                                                                                                |
| `Electrical Engineer` | No       | An existing, active electrical engineer, by name or by phone. Leave it empty if there is none.                                                                                                                                                           |
| `Civil Engineer`      | Yes      | An existing, active civil engineer, by name or by phone.                                                                                                                                                                                                 |
| `Start Date`          | No       | The day work starts, written YYYY-MM-DD, or a date cell. Leave it empty if it is not known.                                                                                                                                                              |
| `Target Date`         | No       | The day the villa is due, written YYYY-MM-DD, or a date cell. It cannot be before the start date.                                                                                                                                                        |
| `Budget`              | No       | The budget, in the currency of the Currency column (KWD when there is none), as a number with at most as many decimals as that currency has: three for KWD (for example 1250000.500), two for EGP or USD, none for JPY. Leave it empty if there is none. |
| `Currency`            | No       | The budget's currency, as a three-letter code (KWD, EGP, USD). Leave it empty for KWD, or leave the whole column out. It can only be given together with a budget.                                                                                       |

How a villa file differs from the others:

- **The headers are the villas export's titles** (`Villa Number`, `Area`, `Civil Engineer`), in its order, not the API's field names. **`Currency` is the one column a file may leave out**: a file without it (the eleven columns of the client's sample) imports every budget in Kuwaiti dinars, the default currency. With it, a row's budget is read with that currency's own decimals (three for KWD, two for EGP and USD, none for JPY); the code is any ISO 4217 code, in any case, and an empty cell means KWD. A currency with no budget is `INVALID_VALUE` on the `Currency` column, and a code that does not exist is too. An export also has `Progress`, `Ready`, `Ready Date` and `Created (UTC)`: they are read past and ignored, because progress and readiness belong to the system. The template has neither of these four, but it has `Currency`, last.
- **Numbers in the text columns.** A spreadsheet often stores a villa number, a block or a plot (`2235`, `4`, `30`) as a number, and the owner name can be one too. These four columns accept a number cell that is a whole number from 0 up to 9,007,199,254,740,991 and read it as the digits it shows (`2235` is `"2235"`: no decimals, no exponent, no separator). A fraction, a negative number or a longer one is `INVALID_VALUE`. A number cell holds no leading zero: write a code like `007` as text. The area, contractor and engineer columns stay text-only (`NOT_TEXT` for a number) because a phone number typed as a number has lost its leading zero.
- **The area** is found by its name, ignoring case and extra spaces. If two areas have the same name, the name alone is `AMBIGUOUS_REFERENCE`: write it as `Name, City` (the text after the last comma is the city).
- **A contractor or an engineer** is found by name (ignoring case and extra spaces) or by phone (ignoring spaces and dashes). Two records that the text names, such as two of one name, are `AMBIGUOUS_REFERENCE` and are never guessed; none is `REFERENCE_NOT_FOUND`; an inactive one is `INVALID_VALUE`. Nothing is created: add the area or the person first.
- **The budget** is in the major units of its currency (dinars, dollars, euros) and is saved exactly, in minor units (`1250000.5` in KWD is 1,250,000,500 fils; `1250000.5` in EGP is 125,000,050 piastres; `1` in JPY is 1 yen; `0.001` in KWD is 1 fil). It can be a number cell or text (`"1250000.50"`), 0 or more, with no more decimals than the currency has; a text with a currency or a thousands separator (`"1,000"`, `"12 EGP"`) is `INVALID_VALUE`. An empty budget saves no budget and no currency. The export writes the budget as a number cell, shown with the decimals of its row's currency (`1,250,000.500` in KWD, `1,250,000.50` in EGP, `1,250,000` in JPY), and as exact text only when a spreadsheet number cannot hold the amount, which the import reads the same.
- **Duplicates.** A villa number is the same villa **ignoring case and extra spaces** (`V-001` and `v-001` are one villa), which is stricter than creating a villa by hand, where the number is compared exactly: a file cannot load `v-001` beside `V-001`. The second rule is the place: the same area, block and plot, also ignoring case and extra spaces, reported on the `Plot` column. Each rule is checked in the file (the first row stands) and against the villas already saved.
- **Each villa is made as one created by hand**, in the same transaction: a progress row at 0 for every phase (switched-off phases too), and a `villa.create` audit entry per villa, plus one `villa.import` entry for the file. The MEW marks and states, and progress, cannot be imported.

## Exporting and importing again

For the seven resources that have an import, a workbook that was exported can be imported again **as it is**, on another environment or after a restore: the export and the template are one list of columns, with the same titles, the same order and the same cell formats, so nothing is renamed, dropped or converted.

- **One list of columns.** The importable columns come first, in the order of the template, and the informational columns come after them. A test compares the header of every export with the template of its import, so they cannot drift apart.
- **The informational columns are read past.** A file may have them, once each, in any place, and whatever they hold is ignored (a value that would be invalid in an importable column does not matter). The template does not have them. Any other column is `IMPORT_HEADER_MISMATCH`.

| Import        | Importable columns                       | Informational columns (export only) |
| ------------- | ---------------------------------------- | ----------------------------------- |
| Villas        | the template, `Currency` last (optional) | `Progress`, `Created (UTC)`         |
| Contractors   | the template                             | `Villas`, `Created (UTC)`           |
| Open works    | the template                             | `Location`, `Overdue`               |
| Daily reports | the template                             | none                                |
| Small works   | the template                             | `Location`                          |
| Site reports  | the template                             | `Location`                          |
| Daily labour  | the template                             | `Location`                          |

- **Cell formats.** Text stays text and keeps its leading zeros (a phone, a plot, a villa number); a date is a date cell and is read as its UTC day; a budget is a number in the major units of its currency (`1250.5`, not `"1250.50 EGP"`); a count and a rating are whole numbers. A text that starts with `=`, `+`, `-` or `@` is written with an apostrophe in front and read back without it. The labels are English words (`Hot`, `In progress`, `Medium`); an import takes the words or the codes, in any case.
- **Progress** has two formats because it means two things: a villa's progress is an average, shown as text with a decimal (`62.5%`) and is informational; an open work's progress is a whole number from 0 to 100 and is importable (`40`).
- **Villa references.** A villa is written by its number. An area, a contractor or an engineer is written by its name, or by name and city (areas), or by phone (people) when another one has the same name, so the file can name exactly one record.
- **Open works.** The export lists every item. The automatic ones (made by the electrical phases) are skipped on import and counted in `skipped`; the manual ones are imported.
- **Daily reports** are written by contractor and electrical engineer, not by villa: the export has no `Villa Number` and no `Location`, and is the template with the data in it.

### What it is for, and what it is not

Exporting and importing is **symmetry, not update in place**. An import only adds records; it never changes one. It is made for loading an export into an environment that does not have the records yet (a new one, or one restored from nothing), not for editing records and putting them back. What happens when the file goes back into the environment it came from:

| Import        | Importing the same records again                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Villas        | every row is `DUPLICATE_EXISTING` (on `Villa Number` and on `Plot`). Nothing is saved.                                                                                                                                                       |
| Contractors   | every row is `DUPLICATE_EXISTING` (name and phone). Nothing is saved.                                                                                                                                                                        |
| Open works    | **no check**: the records have no natural key (an open work has no title), so only the file itself is checked (`FILE_ALREADY_IMPORTED`). An edited copy of an exported file **adds every manual row again**; the automatic rows are skipped. |
| Daily reports | every row is `DUPLICATE_EXISTING` (contractor and report date). Nothing is saved.                                                                                                                                                            |
| Daily labour  | every row is `DUPLICATE_EXISTING` (villa, contractor and labour date). Nothing is saved.                                                                                                                                                     |
| Small works   | **no check**: the records have no natural key (the same work may be written twice), so only the file itself is checked (`FILE_ALREADY_IMPORTED` for the same file). An edited copy of an exported file **adds every row again**.             |
| Site reports  | **no check**, as for the small works. An edited copy adds every row again.                                                                                                                                                                   |

- **What must exist on the target first.** An import never creates a reference. The areas, the civil engineers and the electrical engineers have **no import**: enter them on the target before the villas. Load in this order: areas, engineers and electrical phases by hand, then contractors, then villas, then the records (open works, small works, site reports, daily labour, which name a villa; and the daily reports, which name a contractor and an electrical engineer and need no villa).
- **Inactive and foreign contractors.** A villa takes an active contractor and engineers only: an inactive one is `INVALID_VALUE` on its column. A villa's own records (open works, daily labour) name the villa's own contractor only, and an inactive one is refused too: a contractor who is not that villa's is `CONTRACTOR_NOT_ON_VILLA`. A daily report or a small work takes any active contractor. So a row exported from a record whose contractor has since been made inactive is a row error on the target until the contractor is active again.
- **What a restored record does not keep.** It gets a new id, a creation time of the import, and the importer as its author. A villa starts with every progress at 0 and on no MEW list; the export's `Progress` is not carried over. A villas file exported before ready for inspection was removed still imports: its `Ready` and `Ready Date` columns are accepted and not read.
- **The caps stay.** An import takes at most 2,000 data rows and an export gives at most 10,000 records. **An export of more than 2,000 rows must be split with filters** (a date range, a villa, an area) into files of at most 2,000 rows, each imported on its own; the files are imported one after the other, and the same file is never imported twice (`FILE_ALREADY_IMPORTED`).
