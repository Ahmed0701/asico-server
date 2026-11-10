// Names of the advisory locks (pg_advisory_xact_lock(hashtext(name))) that make two kinds of write take turns.

// The set of elec phases and the progress rows that tie it to the villas. Creating, reordering or deleting a phase, and
// creating a villa, take it first, so a villa and a phase created at the same moment can never miss each other's rows.
export const PHASE_SET_LOCK = "ElecPhase.order";

// LOCK ORDER of the writes that touch a villa's rows. Every transaction takes the locks it needs in this order and never
// goes back, so two of them can wait for each other but never wait in a circle:
//
//   1. PHASE_SET_LOCK (above), by the writes that create, reorder or delete phases or create a villa;
//   2. the villa row (FOR UPDATE by the villa's own update and delete, FOR SHARE by everything that only works inside it:
//      the progress update, the open works' create, update and delete, the small works' create, update and delete, the site reports' create, update and delete, and the daily labour's create, update and delete);
//   3. the elec phase row (FOR UPDATE by the phase's own writes, FOR SHARE by the progress update);
//   4. the villa's progress rows (FOR UPDATE);
//   5. the open works (FOR UPDATE; several in the order of their ids);
//   6. the daily reports, the daily small works, the site reports and the daily labour (FOR UPDATE; one at a time: such a row is never locked together with another).
//
// The two hooks of the open works follow it: the progress hook runs after 2-4 and locks one work (5); the contractor hook
// runs after 2 and locks the villa's automatic works (5).
// The open works' import takes the villas it writes to FOR SHARE in the order of their ids (2) and then only inserts
// works; it comes after its own advisory lock on the import batches, which no other writer in this chain waits for.
// A daily report belongs to no villa, only to a contractor and to the electrical engineer who prepared it, so its writers take
// no villa row: they take the contractor and the engineer FOR SHARE (in the order of their ids, the contractors' table first)
// and then the report row (6). A party's switch-off or delete takes only its own row and waits for them. The daily reports'
// import does the same for the parties the file names, and then only inserts reports; the unique index on (contractor, day)
// has the last word on two writers that both pass the checks.
// The small works: the villa row FOR SHARE (2), then the row (6); their import takes the villas
// FOR SHARE in the order of their ids and then only inserts. They have no unique key, so nothing else decides a race between two
// writers: both rows are valid.
// The site reports follow the small works exactly (no unique key either): the villa row FOR SHARE (2), then the row (6); their
// import takes the villas FOR SHARE in the order of their ids and then only inserts.
// The daily labour: the villa row FOR SHARE (2), then the row (6), so it takes turns with the villa's
// delete and with a change of the villa's contractor (the contractor of a row is checked against the villa's under that lock).
// Its import takes the villas FOR SHARE in the order of their ids and then only inserts; the unique index on (villa, contractor,
// day) has the last word on two writers that both pass the checks.
// The villas' import creates up to 2,000 villas in one transaction, so it takes the locks of a villa's create once for the whole
// file, in the same order: PHASE_SET_LOCK first (1), so no phase is created, reordered or deleted between the villas and their
// progress rows, and then the areas, civil engineers, electrical engineers and contractors the rows use, FOR SHARE, one table
// after the other and each in the order of its ids (what the rows were checked against must still be true: a switched-off or
// deleted party is IMPORT_DATA_CHANGED). The writes to those rows (a party's switch-off or delete, an area's delete) take only
// their own row and wait for this transaction; none of them takes PHASE_SET_LOCK or a villa row first, so none can wait in a
// circle with it. The villas are then inserted in one statement, with the progress rows of all of them in one more; the unique
// indexes on the villa number and on (area, block, plot) have the last word on a villa saved by someone else in the meantime
// (also IMPORT_DATA_CHANGED, with nothing saved). It follows the import's own advisory lock on the import batches, which no
// other writer in this chain waits for.

// The hourly job that raises the due soon and overdue notifications of the small works (and sends their digest email). Every
// server instance runs it on its own timer and each phase takes this lock with pg_try_advisory_xact_lock, so only one instance
// works at a time and the others skip the run. It is not part of the chain above: the job only reads small works and inserts
// notifications, and no writer in that chain waits for it.
export const SMALL_WORKS_ALERT_JOB_LOCK = "SmallWorks.alertJob";
