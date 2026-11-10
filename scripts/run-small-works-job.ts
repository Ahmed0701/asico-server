import { prisma } from "../src/core/database/prisma.js";
import { SmallWorksAlertsService } from "../src/modules/notifications/index.js";

// Runs the small works check ONCE, by hand (npm run jobs:small-works), exactly as the hourly job does: it raises the due soon and
// overdue notifications and sends the digest email to the admins (with SMTP blank, in development, the email is written to a
// file instead; the log says where). It is not an HTTP endpoint. Safe to run at any time and as often as you like: a work that
// already has its notification is skipped, and it waits for nothing if the server is running the job at that moment.
const result = await new SmallWorksAlertsService().run();
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
