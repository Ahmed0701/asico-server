import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailer } from "../../../src/core/mail/index.js";
import type { NotificationKindValue } from "../../../src/modules/notifications/dto/notifications.dto.js";
import type {
  Admin,
  DueSmallWork,
  OverdueOpenWork,
  UnsentNotification,
} from "../../../src/modules/notifications/repository/small-works-alerts.repository.js";
import { SmallWorksAlertsService } from "../../../src/modules/notifications/service/small-works-alerts.service.js";
import type { DeadlinePolicy } from "../../../src/shared/utils/deadline.js";

vi.mock("../../../src/core/database/prisma.js", () => ({ prisma: {} }));

const policy: DeadlinePolicy = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

type Work = {
  id: string;
  status: "PENDING" | "DONE";
  endDate: string;
  villaNumber: string;
  description: string;
  contractorName: string;
};
type OpenWork = {
  id: string;
  status: "IN_PROGRESS" | "DONE";
  endDate: string;
  villaNumber: string;
  phaseName: string;
  contractorName: string | null;
};
type Stored = {
  id: string;
  kind: NotificationKindValue;
  workId: string;
  endDate: string;
  emailedAt: Date | null;
};

// A fake of the repository that applies the same rules as the SQL: which works are due, the unique key of a situation, who is a
// recipient, which notifications are unsent. The queries themselves are tested against a real database (tests/db).
class FakeAlertsRepository {
  works: Work[] = [];
  notifications: Stored[] = [];
  recipients: string[] = ["admin-1", "reader-1"];
  adminList: Admin[] = [{ id: "admin-1", email: "admin@example.test", name: "Root" }];
  locked = true;
  locks = 0;
  private counter = 0;

  async transaction<T>(work: (tx: never) => Promise<T>): Promise<T> {
    return work(undefined as never);
  }

  async tryLock(): Promise<boolean> {
    this.locks += 1;
    return this.locked;
  }

  async findDue({ today, horizon }: { today: string; horizon: string }): Promise<DueSmallWork[]> {
    return this.works
      .filter((work) => work.status === "PENDING" && work.endDate < horizon)
      .map((work) => ({
        work,
        kind: (work.endDate < today ? "SMALL_WORK_OVERDUE" : "SMALL_WORK_DUE_SOON") as NotificationKindValue,
      }))
      .filter(
        ({ work, kind }) =>
          !this.notifications.some(
            (one) => one.workId === work.id && one.kind === kind && one.endDate === work.endDate,
          ),
      )
      .map(({ work, kind }) => ({
        id: work.id,
        kind,
        endDate: day(work.endDate),
        description: work.description,
        villaNumber: work.villaNumber,
        contractorName: work.contractorName,
      }));
  }

  // Open works: overdue once their end date is before the zone's today and they are not done; one notification per end date.
  openWorks: OpenWork[] = [];
  openWorkNotifications: { workId: string; endDate: string; recipients: readonly string[] }[] = [];
  openWorkRecipients: string[] = ["admin-1", "open-works-reader"];

  async findOverdueOpenWorks(today: string): Promise<OverdueOpenWork[]> {
    return this.openWorks
      .filter((work) => work.status !== "DONE" && work.endDate < today)
      .filter(
        (work) =>
          !this.openWorkNotifications.some((one) => one.workId === work.id && one.endDate === work.endDate),
      )
      .map((work) => ({
        id: work.id,
        endDate: day(work.endDate),
        phaseName: work.phaseName,
        villaNumber: work.villaNumber,
        contractorName: work.contractorName,
      }));
  }

  async createOpenWorkNotifications(
    works: readonly OverdueOpenWork[],
    recipientIds: readonly string[],
  ): Promise<number> {
    for (const work of works) {
      this.openWorkNotifications.push({
        workId: work.id,
        endDate: work.endDate.toISOString().slice(0, 10),
        recipients: recipientIds,
      });
    }
    return works.length;
  }

  async recipientIds(_db?: unknown, permission?: string): Promise<string[]> {
    return permission === "open-works:read" ? this.openWorkRecipients : this.recipients;
  }

  async admins(): Promise<Admin[]> {
    return this.adminList;
  }

  async createNotifications(works: readonly DueSmallWork[], recipientIds: readonly string[]) {
    expect(recipientIds).toEqual(this.recipients);
    const made = works.map((work) => ({
      id: `n-${(this.counter += 1)}`,
      kind: work.kind,
      workId: work.id,
      endDate: work.endDate.toISOString().slice(0, 10),
      emailedAt: null,
    }));
    this.notifications.push(...made);
    return made.map(({ id, kind }) => ({ id, kind }));
  }

  async unsent(): Promise<UnsentNotification[]> {
    return this.notifications
      .filter(
        (one) =>
          one.emailedAt === null && this.works.find((work) => work.id === one.workId)?.status === "PENDING",
      )
      .map((one) => {
        const work = this.works.find((w) => w.id === one.workId)!;
        return {
          id: one.id,
          kind: one.kind,
          data: {
            villaNumber: work.villaNumber,
            description: work.description,
            contractorName: work.contractorName,
            endDate: one.endDate,
          },
        };
      });
  }

  async markEmailed(ids: readonly string[], now: Date): Promise<void> {
    for (const one of this.notifications) {
      if (ids.includes(one.id) && one.emailedAt === null) {
        one.emailedAt = now;
      }
    }
  }
}

let repository: FakeAlertsRepository;
let sent: { to: string; subject: string; text: string }[];
let failFor: Set<string>;
let now: Date;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const mailer = (): Mailer => ({
  async send(message) {
    if (failFor.has(message.to)) {
      throw new Error("smtp down");
    }
    sent.push({ to: message.to, subject: message.subject, text: message.text });
  },
});

const service = () =>
  new SmallWorksAlertsService(repository as never, () => now, policy, mailer, logger as never);

const addWork = (extra: Partial<Work> = {}): Work => {
  const work: Work = {
    id: `w-${repository.works.length + 1}`,
    status: "PENDING",
    endDate: "2026-11-05",
    villaNumber: "P-001",
    description: "Seal the sleeves",
    contractorName: "Nile Builders",
    ...extra,
  };
  repository.works.push(work);
  return work;
};

// Kuwait: a work ending 2026-11-05 is due soon from 13:00Z and overdue from 21:00Z that day.
const BEFORE_WINDOW = new Date("2026-11-05T12:59:00.000Z");
const IN_WINDOW = new Date("2026-11-05T13:00:00.000Z");
const PAST_DEADLINE = new Date("2026-11-05T21:00:00.000Z");

beforeEach(() => {
  repository = new FakeAlertsRepository();
  sent = [];
  failFor = new Set();
  now = IN_WINDOW;
  vi.clearAllMocks();
});

describe("raising notifications", () => {
  it("raises nothing before the alert window", async () => {
    addWork();
    now = BEFORE_WINDOW;

    const result = await service().run();

    expect(result).toEqual({
      skipped: false,
      raised: { dueSoon: 0, overdue: 0, openWorksOverdue: 0 },
      digest: { notifications: 0, sent: 0, failed: 0 },
    });
    expect(repository.notifications).toEqual([]);
  });

  it("raises one DUE_SOON notification in the alert window", async () => {
    addWork();

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 1, overdue: 0, openWorksOverdue: 0 });
    expect(repository.notifications).toMatchObject([{ kind: "SMALL_WORK_DUE_SOON", endDate: "2026-11-05" }]);
  });

  it("raises one OVERDUE notification once the deadline has passed", async () => {
    addWork();
    now = PAST_DEADLINE;

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
    expect(repository.notifications).toMatchObject([{ kind: "SMALL_WORK_OVERDUE" }]);
  });

  it("raises each situation once: a rerun in the same hour, and in the next ones, raises nothing", async () => {
    addWork();
    await service().run();

    for (const iso of ["2026-11-05T13:00:00.000Z", "2026-11-05T14:00:00.000Z", "2026-11-05T20:59:00.000Z"]) {
      now = new Date(iso);
      expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    }
    expect(repository.notifications).toHaveLength(1);
  });

  it("raises OVERDUE after DUE_SOON for the same work: two situations, two notifications", async () => {
    addWork();
    await service().run();
    now = PAST_DEADLINE;

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
    expect(repository.notifications.map((one) => one.kind)).toEqual([
      "SMALL_WORK_DUE_SOON",
      "SMALL_WORK_OVERDUE",
    ]);
  });

  it("raises OVERDUE straight away for a work the job never saw (the server was down)", async () => {
    addWork({ endDate: "2026-10-01" });

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
  });

  it("ignores a work that is DONE", async () => {
    addWork({ status: "DONE" });
    addWork({ status: "DONE", endDate: "2026-10-01" });

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    expect(sent).toEqual([]);
  });

  it("raises again when the end date is edited to a new one that is due", async () => {
    const work = addWork();
    await service().run();
    work.endDate = "2026-11-06";
    now = new Date("2026-11-06T13:00:00.000Z");

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 1, overdue: 0, openWorksOverdue: 0 });
    expect(repository.notifications.map((one) => one.endDate)).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("raises again when a work goes back from DONE to PENDING with a different end date, and not for the same one", async () => {
    const work = addWork();
    await service().run();
    work.status = "DONE";
    expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    work.status = "PENDING";
    expect((await service().run()).raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    work.endDate = "2026-11-04";

    const result = await service().run();

    expect(result.raised).toEqual({ dueSoon: 0, overdue: 1, openWorksOverdue: 0 });
  });

  it("passes every recipient to the repository", async () => {
    addWork();
    repository.recipients = ["admin-1", "admin-2", "reader-1"];

    await service().run();

    expect(repository.notifications).toHaveLength(1);
  });
});

describe("overdue open works", () => {
  const addOpenWork = (extra: Partial<OpenWork> = {}): OpenWork => {
    const work: OpenWork = {
      id: `ow-${repository.openWorks.length + 1}`,
      status: "IN_PROGRESS",
      endDate: "2026-11-05",
      villaNumber: "P-001",
      phaseName: "Wiring",
      contractorName: null,
      ...extra,
    };
    repository.openWorks.push(work);
    return work;
  };

  it("raises nothing while the end date is still today in Kuwait", async () => {
    addOpenWork();
    now = new Date("2026-11-05T20:59:00.000Z");

    expect((await service().run()).raised.openWorksOverdue).toBe(0);
    expect(repository.openWorkNotifications).toEqual([]);
  });

  it("raises one notification from Kuwait's midnight after the end date, for the admins and the open works readers", async () => {
    const work = addOpenWork();
    now = PAST_DEADLINE;

    expect((await service().run()).raised.openWorksOverdue).toBe(1);
    expect(repository.openWorkNotifications).toEqual([
      { workId: work.id, endDate: "2026-11-05", recipients: ["admin-1", "open-works-reader"] },
    ]);
  });

  it("raises each end date once, ignores done works, and raises again when the end date moves", async () => {
    const work = addOpenWork();
    addOpenWork({ status: "DONE" });
    now = PAST_DEADLINE;

    expect((await service().run()).raised.openWorksOverdue).toBe(1);
    expect((await service().run()).raised.openWorksOverdue).toBe(0);

    work.endDate = "2026-11-04";
    expect((await service().run()).raised.openWorksOverdue).toBe(1);
  });

  it("never emails an open work: the digest lists only small works", async () => {
    addOpenWork();
    now = PAST_DEADLINE;

    const result = await service().run();

    expect(result.raised.openWorksOverdue).toBe(1);
    expect(result.digest.notifications).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("the lock", () => {
  it("does nothing, and says so, when another instance holds it", async () => {
    addWork();
    repository.locked = false;

    const result = await service().run();

    expect(result).toEqual({
      skipped: true,
      raised: { dueSoon: 0, overdue: 0, openWorksOverdue: 0 },
      digest: { notifications: 0, sent: 0, failed: 0 },
    });
    expect(repository.notifications).toEqual([]);
    expect(sent).toEqual([]);
    expect(repository.locks).toBe(1);
  });

  it("takes the lock for each of its two phases", async () => {
    addWork();

    await service().run();

    expect(repository.locks).toBe(2);
  });
});

describe("the digest email", () => {
  it("sends one email to each active admin, once for everything raised in the run", async () => {
    repository.adminList = [
      { id: "admin-1", email: "a@example.test", name: "A" },
      { id: "admin-2", email: "b@example.test", name: "B" },
    ];
    addWork({ villaNumber: "P-001" });
    addWork({ villaNumber: "P-002", endDate: "2026-11-04" });

    const result = await service().run();

    expect(result.digest).toEqual({ notifications: 2, sent: 2, failed: 0 });
    expect(sent.map((one) => one.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(sent[0]!.subject).toContain("1");
    expect(sent[0]!.text).toContain("P-001");
    expect(sent[0]!.text).toContain("P-002");
    expect(repository.notifications.every((one) => one.emailedAt?.getTime() === IN_WINDOW.getTime())).toBe(
      true,
    );
  });

  it("does not send the same notification twice: the next run, with nothing new, sends nothing", async () => {
    addWork();
    await service().run();
    sent = [];

    const result = await service().run();

    expect(result.digest).toEqual({ notifications: 0, sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it("sends nothing when nothing was raised", async () => {
    now = BEFORE_WINDOW;
    addWork();

    await service().run();

    expect(sent).toEqual([]);
  });

  it("retries on the next run when every send failed, without raising again", async () => {
    addWork();
    failFor.add("admin@example.test");

    const first = await service().run();

    expect(first.raised.dueSoon).toBe(1);
    expect(first.digest).toEqual({ notifications: 1, sent: 0, failed: 1 });
    expect(repository.notifications[0]!.emailedAt).toBeNull();

    failFor.clear();
    const second = await service().run();

    expect(second.raised).toEqual({ dueSoon: 0, overdue: 0, openWorksOverdue: 0 });
    expect(second.digest).toEqual({ notifications: 1, sent: 1, failed: 0 });
    expect(repository.notifications[0]!.emailedAt).not.toBeNull();
  });

  it("goes on to the other admins when one send fails, and counts it as emailed once one went out", async () => {
    repository.adminList = [
      { id: "admin-1", email: "a@example.test", name: "A" },
      { id: "admin-2", email: "b@example.test", name: "B" },
    ];
    failFor.add("a@example.test");
    addWork();

    const result = await service().run();

    expect(result.digest).toEqual({ notifications: 1, sent: 1, failed: 1 });
    expect(sent.map((one) => one.to)).toEqual(["b@example.test"]);
    expect(repository.notifications[0]!.emailedAt).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("a@example.test");
  });

  it("keeps the notifications for the people when there is no admin to email, and sends later when there is one", async () => {
    repository.adminList = [];
    addWork();

    const first = await service().run();

    expect(first.raised.dueSoon).toBe(1);
    expect(first.digest).toEqual({ notifications: 0, sent: 0, failed: 0 });
    expect(repository.notifications[0]!.emailedAt).toBeNull();

    repository.adminList = [{ id: "admin-1", email: "admin@example.test", name: "Root" }];
    const second = await service().run();

    expect(second.digest).toEqual({ notifications: 1, sent: 1, failed: 0 });
  });

  it("does not email a notification whose work was marked DONE in the meantime", async () => {
    const work = addWork();
    repository.adminList = [];
    await service().run();
    work.status = "DONE";
    repository.adminList = [{ id: "admin-1", email: "admin@example.test", name: "Root" }];

    const result = await service().run();

    expect(result.digest).toEqual({ notifications: 0, sent: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it("lists overdue works and due soon works in separate sections of the one email, the overdue ones first", async () => {
    addWork({ villaNumber: "P-OVER", endDate: "2026-11-03" });
    addWork({ villaNumber: "P-SOON", endDate: "2026-11-05" });

    await service().run();

    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    const at = (needle: string): number => text.indexOf(needle);
    expect(sent[0]!.subject.startsWith("Small works: 1 due soon, 1 overdue | ")).toBe(true);
    expect(at("Overdue (1)")).toBeGreaterThan(-1);
    expect(at("Overdue (1)")).toBeLessThan(at("P-OVER"));
    expect(at("P-OVER")).toBeLessThan(at("Due soon (1)"));
    expect(at("Due soon (1)")).toBeLessThan(at("P-SOON"));
  });
});
