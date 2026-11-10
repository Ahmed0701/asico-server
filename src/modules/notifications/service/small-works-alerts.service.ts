import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { logger as defaultLogger } from "../../../core/config/logger.js";
import {
  getMailer,
  renderSmallWorksDigest,
  type DigestInput,
  type Mailer,
} from "../../../core/mail/index.js";
import { PERMISSIONS } from "../../../shared/constants/permissions.js";
import { alertWindow, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { dataOf } from "../mapper/notifications.mapper.js";
import {
  SmallWorksAlertsRepository,
  type UnsentNotification,
} from "../repository/small-works-alerts.repository.js";

export type AlertRunResult = {
  // true: another server instance was running the job, so this run did nothing.
  skipped: boolean;
  // The notifications this run made, by kind: small works due soon and overdue, and open works overdue.
  raised: { dueSoon: number; overdue: number; openWorksOverdue: number };
  // The digest: notifications it listed, emails sent, and emails that failed (those are retried by the next run).
  digest: { notifications: number; sent: number; failed: number };
};

const NOTHING: AlertRunResult = {
  skipped: false,
  raised: { dueSoon: 0, overdue: 0, openWorksOverdue: 0 },
  digest: { notifications: 0, sent: 0, failed: 0 },
};

// The second phase holds its transaction (and the lock) while the emails go out, one admin after the other, each with the mail
// server's own time limits (core/mail/mailer.ts).
const TRANSACTION = { maxWait: 10_000, timeout: 300_000 } as const;

const byEndDate = (a: DigestInput["dueSoon"][number], b: DigestInput["dueSoon"][number]): number =>
  a.endDate.localeCompare(b.endDate) || a.villaNumber.localeCompare(b.villaNumber);

// The hourly job of the small works. A pending work that is overdue, or due soon, gets ONE notification for its situation (the
// work, the kind and the end date), seen by the active admins and by the active users who may read small works. The admins also get
// ONE digest email per run, with the notifications that have not been emailed yet. Nothing in it is audited.
//
// Safe to rerun and to race: each phase takes a Postgres advisory lock without waiting (another instance doing the work makes this
// one skip), and the unique key of a notification has the last word. A failed email never stops the job and is retried by the
// next run, because a notification is marked emailed only once an email carrying it was sent.
export class SmallWorksAlertsService {
  // `clock`, `policy` and the mailer are injectable so tests use no real time, zone or mail server.
  constructor(
    private readonly repository = new SmallWorksAlertsRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly policy: DeadlinePolicy = envDeadlinePolicy(),
    private readonly mailer: () => Mailer = getMailer,
    private readonly logger = defaultLogger,
  ) {}

  async run(): Promise<AlertRunResult> {
    const now = this.clock();
    const raised = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.tryLock(tx))) {
        return null;
      }
      const window = alertWindow(now, this.policy);
      const due = await this.repository.findDue(window, tx);
      const made = await this.repository.createNotifications(due, await this.repository.recipientIds(tx), tx);
      // The open works that are past their end date in APP_TIMEZONE, seen by the admins and by who may read open works.
      const lateOpenWorks = await this.repository.findOverdueOpenWorks(window.today, tx);
      const openWorksOverdue = await this.repository.createOpenWorkNotifications(
        lateOpenWorks,
        lateOpenWorks.length > 0 ? await this.repository.recipientIds(tx, PERMISSIONS.OPEN_WORKS_READ) : [],
        tx,
      );
      return {
        dueSoon: made.filter((one) => one.kind === "SMALL_WORK_DUE_SOON").length,
        overdue: made.filter((one) => one.kind === "SMALL_WORK_OVERDUE").length,
        openWorksOverdue,
      };
    }, TRANSACTION);
    if (raised === null) {
      this.logger.info("small works alerts: another instance is running the job, skipped");
      return { ...NOTHING, skipped: true };
    }

    // The digest is a phase of its own, so a notification made above is never lost to a failure below, and one that could not
    // be emailed before is tried again even when this run made nothing new.
    const digest = (await this.sendDigest(now)) ?? NOTHING.digest;
    const result: AlertRunResult = { skipped: false, raised, digest };
    this.logger.info(result, "small works alerts: run finished");
    return result;
  }

  private sendDigest(now: Date): Promise<AlertRunResult["digest"] | null> {
    return this.repository.transaction(async (tx) => {
      if (!(await this.repository.tryLock(tx))) {
        return null;
      }
      const unsent = await this.repository.unsent(tx);
      const admins = await this.repository.admins(tx);
      if (unsent.length === 0 || admins.length === 0) {
        return NOTHING.digest;
      }
      const email = renderSmallWorksDigest(digestOf(unsent));
      let sent = 0;
      let failed = 0;
      for (const admin of admins) {
        try {
          await this.mailer().send({ to: admin.email, ...email });
          sent += 1;
        } catch (err) {
          failed += 1;
          // The address is not logged: the log keeps no personal data.
          this.logger.warn({ err, admin: admin.id }, "small works alerts: the digest email was not sent");
        }
      }
      // Marked once at least one email carrying it went out. If every send failed, the next run tries again.
      if (sent > 0) {
        await this.repository.markEmailed(
          unsent.map((one) => one.id),
          now,
          tx,
        );
      }
      return { notifications: unsent.length, sent, failed };
    }, TRANSACTION);
  }
}

function digestOf(unsent: readonly UnsentNotification[]): DigestInput {
  const dueSoon: DigestInput["dueSoon"][number][] = [];
  const overdue: DigestInput["overdue"][number][] = [];
  for (const one of unsent) {
    (one.kind === "SMALL_WORK_OVERDUE" ? overdue : dueSoon).push(dataOf(one.data));
  }
  return { dueSoon: dueSoon.sort(byEndDate), overdue: overdue.sort(byEndDate) };
}
