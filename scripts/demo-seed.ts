import ExcelJS from "exceljs";
import { envDeadlinePolicy } from "../src/core/config/deadlinePolicy.js";
import { env } from "../src/core/config/env.js";
import { prisma } from "../src/core/database/prisma.js";
import type { Actor, RequestContext } from "../src/core/middleware/requestContext.js";
import { AreasService } from "../src/modules/areas/service/areas.service.js";
import { CivilEngineersService } from "../src/modules/civil-engineers/service/civil-engineers.service.js";
import { ContractorsImportService } from "../src/modules/contractors/service/contractors-import.service.js";
import { DailyLabourImportService } from "../src/modules/daily-labour/service/daily-labour-import.service.js";
import { DailyReportsImportService } from "../src/modules/daily-reports/service/daily-reports-import.service.js";
import { ElectricalEngineersService } from "../src/modules/electrical-engineers/service/electrical-engineers.service.js";
import { OpenWorksImportService } from "../src/modules/open-works/service/open-works-import.service.js";
import { SiteReportsImportService } from "../src/modules/site-reports/service/site-reports-import.service.js";
import { SmallWorksImportService } from "../src/modules/small-works/service/small-works-import.service.js";
import { VillaProgressService } from "../src/modules/villa-progress/service/villa-progress.service.js";
import { VillasImportService } from "../src/modules/villas/service/villas-import.service.js";
import { localDayOf } from "../src/shared/utils/deadline.js";

// DEMO ONLY. Fills an EMPTY database with a small made-up project, so the system can be shown to a client: 1 area, 2
// contractors, 2 civil engineers, 1 electrical engineer and 8 villas (made-up owners, budgets in KWD) with phase progress, open
// works, daily reports (one per contractor and day), small works, site reports and daily labour. Everything goes through the real
// services: the five lists through their import templates (the file is the template with the example row replaced), the rest
// through the services the API uses, so the audit log, the versions and the automatic open works are the real ones. No HTTP, no rate limits.
//
//   npx tsx scripts/demo-seed.ts            fills the database (the one in DATABASE_URL, printed first)
//   npx tsx scripts/demo-seed.ts --remove   deletes exactly the records this script made, and nothing else
//
// It refuses to fill a database that already holds an area, a contractor, an engineer or a villa, so it can never mix with real
// data. Under NODE_ENV=production it also needs DEMO_SEED_ALLOW_PRODUCTION=yes. An ADMIN user must exist (npm run prisma:seed).
// The audit log is append-only, so its rows about the demo records stay after --remove.

const remove = process.argv.includes("--remove");
const ctx: RequestContext = { locale: "en" };

const AREA = { name: "Al Rawda Heights", city: "Kuwait City" };

const CONTRACTORS = [
  {
    name: "Gulf Horizon Contracting",
    phone: "+965 2222 0101",
    email: "info@gulfhorizon.example.com",
    status: "Active",
  },
  { name: "Al Noor Builders", phone: "+965 2222 0202", email: "office@alnoor.example.com", status: "Active" },
] as const;

const CIVIL_ENGINEERS = [
  { name: "Eng. Fahad Al-Sabah", phone: "+965 5000 1001", email: "fahad@demo.example.com" },
  { name: "Eng. Noura Al-Rashid", phone: "+965 5000 1002", email: "noura@demo.example.com" },
] as const;

const ELECTRICAL_ENGINEER = {
  name: "Eng. Salem Al-Enezi",
  phone: "+965 5000 2001",
  email: "salem@demo.example.com",
} as const;

type DemoVilla = {
  number: string;
  owner: string;
  block: string;
  plot: string;
  contractor: number;
  civil: number;
  startDaysAgo: number;
  // Days from today to the target date; negative is past, so that villa is late.
  targetInDays: number;
  budgetKwd: string;
  // The progress of the six electrical phases, in their display order.
  progress: readonly number[];
};

const VILLAS: readonly DemoVilla[] = [
  {
    number: "V-101",
    owner: "Yousef Al-Mutairi",
    block: "A1",
    plot: "12",
    contractor: 0,
    civil: 0,
    startDaysAgo: 210,
    targetInDays: 25,
    budgetKwd: "185000.500",
    progress: [100, 100, 100, 100, 100, 80],
  },
  {
    number: "V-102",
    owner: "Mariam Al-Kandari",
    block: "A1",
    plot: "14",
    contractor: 0,
    civil: 1,
    startDaysAgo: 180,
    targetInDays: 60,
    budgetKwd: "210500.000",
    progress: [100, 100, 100, 90, 60, 20],
  },
  {
    number: "V-103",
    owner: "Hamad Al-Dosari",
    block: "A2",
    plot: "3",
    contractor: 0,
    civil: 0,
    startDaysAgo: 240,
    targetInDays: -15,
    budgetKwd: "172250.250",
    progress: [100, 100, 70, 40, 10, 0],
  },
  {
    number: "V-104",
    owner: "Latifa Al-Ajmi",
    block: "A2",
    plot: "5",
    contractor: 0,
    civil: 1,
    startDaysAgo: 260,
    targetInDays: -5,
    budgetKwd: "198000.000",
    progress: [100, 100, 100, 100, 100, 100],
  },
  {
    number: "V-105",
    owner: "Bader Al-Hajri",
    block: "B1",
    plot: "7",
    contractor: 1,
    civil: 0,
    startDaysAgo: 120,
    targetInDays: 110,
    budgetKwd: "225750.750",
    progress: [100, 60, 30, 0, 0, 0],
  },
  {
    number: "V-106",
    owner: "Dana Al-Failakawi",
    block: "B1",
    plot: "9",
    contractor: 1,
    civil: 1,
    startDaysAgo: 90,
    targetInDays: 150,
    budgetKwd: "240000.000",
    progress: [80, 40, 0, 0, 0, 0],
  },
  {
    number: "V-107",
    owner: "Khalid Al-Otaibi",
    block: "B2",
    plot: "2",
    contractor: 1,
    civil: 0,
    startDaysAgo: 45,
    targetInDays: 200,
    budgetKwd: "205300.125",
    progress: [30, 0, 0, 0, 0, 0],
  },
  {
    number: "V-108",
    owner: "Sara Al-Mansour",
    block: "B2",
    plot: "4",
    contractor: 1,
    civil: 1,
    startDaysAgo: 10,
    targetInDays: 260,
    budgetKwd: "232000.000",
    progress: [0, 0, 0, 0, 0, 0],
  },
];

// The calendar day `offset` days from today, as the YYYY-MM-DD text a template cell holds.
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const contractorOf = (villa: DemoVilla): string => CONTRACTORS[villa.contractor]!.name;

function describeTarget(): string {
  const url = new URL(env.DATABASE_URL);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

function refuse(message: string): never {
  console.error(`demo-seed: ${message}`);
  process.exit(1);
}

type Template = { template(): Promise<{ bytes: Buffer }> };
type Importer = Template & {
  importFile(
    actor: Actor,
    file: { name: string; bytes: Buffer },
    dryRun: boolean,
    ctx: RequestContext,
  ): Promise<{
    status: number;
    report: { imported: number; errors: { row: number; column: string; message: string }[] };
  }>;
};

// The template of the service with its example row replaced by `rows` (header text -> cell text). The headers are read from
// the template, so the file always matches the real columns; a key that is not a header is a mistake in this script.
async function fileOf(service: Template, rows: readonly Record<string, string>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await service.template()).bytes as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0]!;
  const headers = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String);
  sheet.spliceRows(2, 1);
  rows.forEach((row, r) => {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) {
        throw new Error(`"${key}" is not a column of the template (${headers.join(", ")})`);
      }
    }
    headers.forEach((header, c) => {
      const value = row[header];
      if (value !== undefined) {
        sheet.getCell(r + 2, c + 1).value = value;
      }
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function importRows(
  label: string,
  actor: Actor,
  service: Importer,
  rows: readonly Record<string, string>[],
): Promise<void> {
  const outcome = await service.importFile(
    actor,
    { name: `demo-${label}.xlsx`, bytes: await fileOf(service, rows) },
    false,
    ctx,
  );
  if (outcome.status !== 201) {
    const problems = outcome.report.errors
      .slice(0, 10)
      .map((e) => `  row ${e.row}, ${e.column}: ${e.message}`);
    throw new Error(`the ${label} import was refused:\n${problems.join("\n")}`);
  }
  console.log(`  ${label}: ${outcome.report.imported}`);
}

async function create(): Promise<void> {
  const holds = await Promise.all([
    prisma.area.count(),
    prisma.contractor.count(),
    prisma.civilEngineer.count(),
    prisma.electricalEngineer.count(),
    prisma.villa.count(),
  ]);
  if (holds.some((count) => count > 0)) {
    refuse(
      "the database already holds areas, contractors, engineers or villas. This script only fills an empty one, so that it can never mix with real data. Use a new database (for example asico_demo), or --remove if the records are the demo's.",
    );
  }
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!admin) {
    refuse(
      "there is no ADMIN user. Run `npm run prisma:seed` first (it creates one from ADMIN_EMAIL and ADMIN_PASSWORD).",
    );
  }
  const actor: Actor = { id: admin.id, role: admin.role };

  console.log("creating:");
  const area = await new AreasService().create(actor, AREA, ctx);
  console.log("  areas: 1");
  const civil = new CivilEngineersService();
  for (const engineer of CIVIL_ENGINEERS) {
    await civil.create(actor, engineer, ctx);
  }
  console.log(`  civil engineers: ${CIVIL_ENGINEERS.length}`);
  await new ElectricalEngineersService().create(actor, ELECTRICAL_ENGINEER, ctx);
  console.log("  electrical engineers: 1");

  await importRows(
    "contractors",
    actor,
    new ContractorsImportService(),
    CONTRACTORS.map((c) => ({ Name: c.name, Phone: c.phone, Email: c.email, Status: c.status })),
  );
  await importRows(
    "villas",
    actor,
    new VillasImportService(),
    VILLAS.map((v) => ({
      "Villa Number": v.number,
      "Owner Name": v.owner,
      Area: area.name,
      Block: v.block,
      Plot: v.plot,
      Contractor: contractorOf(v),
      "Electrical Engineer": ELECTRICAL_ENGINEER.name,
      "Civil Engineer": CIVIL_ENGINEERS[v.civil]!.name,
      "Start Date": day(-v.startDaysAgo),
      "Target Date": day(v.targetInDays),
      Budget: v.budgetKwd,
      Currency: "KWD",
    })),
  );

  // The phase progress goes through the progress service, which also makes the automatic open works.
  const phases = await prisma.elecPhase.findMany({
    where: { status: "ACTIVE" },
    orderBy: { sortOrder: "asc" },
  });
  const villas = new Map(
    (await prisma.villa.findMany({ select: { id: true, villaNumber: true } })).map((v) => [
      v.villaNumber,
      v.id,
    ]),
  );
  const progress = new VillaProgressService();
  let updates = 0;
  for (const villa of VILLAS) {
    for (const [index, value] of villa.progress.entries()) {
      const phase = phases[index];
      if (phase && value > 0) {
        await progress.update(actor, villas.get(villa.number)!, phase.id, { progress: value }, ctx);
        updates += 1;
      }
    }
  }
  console.log(`  phase progress updates: ${updates}`);

  const started = VILLAS.slice(0, 7);
  // An open work is filed under an electrical phase and has no title of its own: the phase names it.
  const firstFix = phases[2]?.name ?? phases[0]!.name;
  const finishing = phases[phases.length - 1]!.name;
  await importRows(
    "open works",
    actor,
    new OpenWorksImportService(),
    started.flatMap((v, i) => [
      {
        "Villa Number": v.number,
        "Electrical Phase": firstFix,
        Status: i === 2 ? "Delayed" : "In progress",
        Priority: i === 2 ? "High" : "Medium",
        Progress: String(20 + i * 10),
        Contractor: contractorOf(v),
        "Start Date": day(-30),
        "End Date": day(i === 2 ? -3 : 20),
      },
      {
        "Villa Number": v.number,
        "Electrical Phase": finishing,
        Status: i % 2 === 0 ? "Not started" : "In progress",
        Priority: "Low",
        Progress: i % 2 === 0 ? "0" : "50",
        Contractor: contractorOf(v),
        "Start Date": day(-10),
        "End Date": day(40),
      },
    ]),
  );
  // A daily report is of a contractor (not of a villa) and is prepared by an electrical engineer: one per contractor and day.
  await importRows(
    "daily reports",
    actor,
    new DailyReportsImportService(),
    CONTRACTORS.flatMap((c, i) =>
      [0, 1, 2].map((back) => ({
        "Report Date": day(-back),
        Contractor: c.name,
        "Electrical Engineer": ELECTRICAL_ENGINEER.name,
        Weather: ["Sunny", "Hot", "Windy", "Dusty"][(i + back) % 4]!,
        Workers: String(18 + i * 7 + back),
        Notes: back === 1 ? "Cement delivery was late" : "",
      })),
    ),
  );
  // The small works have a start and an end date and a contractor. Their deadline is the end of the end date in APP_TIMEZONE, so
  // the days are counted in that zone: one finished, some overdue (the end date has passed), one due today (it shows as "due
  // soon" in the last hours of the day, before the deadline) and the rest still ahead.
  const workDay = (offset: number): string =>
    localDayOf(new Date(Date.now() + offset * 86_400_000), envDeadlinePolicy().timeZone);
  await importRows(
    "small works",
    actor,
    new SmallWorksImportService(),
    VILLAS.slice(0, 5).flatMap((v, i) => {
      const contractor = CONTRACTORS[(v.contractor + i) % CONTRACTORS.length]!.name;
      return [
        {
          "Villa Number": v.number,
          "Start Date": workDay(-4),
          "End Date": workDay(-2),
          Description: "Replaced a broken socket in the hall",
          Contractor: contractor,
          Status: "Done",
        },
        {
          "Villa Number": v.number,
          "Start Date": workDay(i % 2 === 0 ? -5 : -1),
          "End Date": workDay(i === 0 ? 0 : i % 2 === 0 ? -1 : 3 + i),
          Description: "Sealed the open sleeves before plastering",
          Contractor: contractor,
          Status: "Pending",
        },
      ];
    }),
  );
  await importRows(
    "site reports",
    actor,
    new SiteReportsImportService(),
    VILLAS.slice(0, 5).map((v, i) => ({
      "Villa Number": v.number,
      Title: i % 2 === 0 ? "Electrical first fix check" : "Safety walk of the site",
      "Visit Date": day(-4),
      Inspector: ELECTRICAL_ENGINEER.name,
      Type: i % 2 === 0 ? "Inspection" : "Safety",
      Rating: String(3 + (i % 3)),
      Findings: "Conduits are fixed and the boxes are at the right height",
      Recommendations: "Seal the open sleeves before plastering",
    })),
  );
  await importRows(
    "daily labour",
    actor,
    new DailyLabourImportService(),
    VILLAS.slice(0, 6).flatMap((v, i) =>
      [0, 1, 2].map((back) => ({
        "Villa Number": v.number,
        "Labour Date": day(-back),
        "Labour Count": String(20 + i * 2 + back),
        Contractor: contractorOf(v),
        Notes: back === 0 ? "Half the team worked on the roof" : "",
      })),
    ),
  );
  console.log("done. Sign in with the ADMIN user to see it.");
}

// Deletes the demo's records: a record is the demo's only if it matches this script's names (a villa also by its owner), so a
// real record is never touched. One transaction: if a real villa uses a demo contractor or engineer the whole thing rolls back.
async function removeDemo(): Promise<void> {
  const areaRow = await prisma.area.findFirst({ where: AREA });
  const counts = await prisma.$transaction(async (tx) => {
    const villas = await tx.villa.findMany({
      where: { OR: VILLAS.map((v) => ({ villaNumber: v.number, ownerName: v.owner })) },
      select: { id: true },
    });
    const villaId = { in: villas.map((v) => v.id) };
    // The records that block a villa's delete go first; the open works, progress and documents go with the villa.
    const removed = {
      dailyLabour: (await tx.dailyLabour.deleteMany({ where: { villaId } })).count,
      siteReports: (await tx.siteReport.deleteMany({ where: { villaId } })).count,
      smallWorks: (await tx.dailySmallWork.deleteMany({ where: { villaId } })).count,
      // A daily report belongs to a contractor, not to a villa; the demo's contractors' reports are the demo's.
      dailyReports: (
        await tx.dailyReport.deleteMany({
          where: { contractor: { name: { in: CONTRACTORS.map((c) => c.name) } } },
        })
      ).count,
      villas: (await tx.villa.deleteMany({ where: { id: villaId } })).count,
      contractors: (
        await tx.contractor.deleteMany({ where: { name: { in: CONTRACTORS.map((c) => c.name) } } })
      ).count,
      civilEngineers: (
        await tx.civilEngineer.deleteMany({
          where: { OR: CIVIL_ENGINEERS.map((e) => ({ name: e.name, phone: e.phone })) },
        })
      ).count,
      electricalEngineers: (
        await tx.electricalEngineer.deleteMany({
          where: { name: ELECTRICAL_ENGINEER.name, phone: ELECTRICAL_ENGINEER.phone },
        })
      ).count,
      areas: (await tx.area.deleteMany({ where: AREA })).count,
      importBatches: 0,
    };
    // The import log keeps a hash of each file so that a file cannot be imported twice; the demo's files go, or the demo
    // could not be made again. They were all made within minutes of the area.
    if (areaRow) {
      removed.importBatches = (
        await tx.importBatch.deleteMany({
          where: {
            createdAt: { gte: areaRow.createdAt, lte: new Date(areaRow.createdAt.getTime() + 30 * 60_000) },
          },
        })
      ).count;
    }
    return removed;
  });
  console.log("removed:", counts);
}

console.log(`demo-seed: NODE_ENV=${env.NODE_ENV}, database ${describeTarget()}${remove ? " (remove)" : ""}`);
if (env.NODE_ENV === "production" && process.env["DEMO_SEED_ALLOW_PRODUCTION"] !== "yes") {
  refuse(
    "NODE_ENV is production. Set DEMO_SEED_ALLOW_PRODUCTION=yes to run it on a database made for the demo.",
  );
}
try {
  await (remove ? removeDemo() : create());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  console.error(
    remove
      ? "demo-seed: nothing was removed."
      : "demo-seed: stopped part way. Run it again with --remove, then fix the problem and fill again.",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
