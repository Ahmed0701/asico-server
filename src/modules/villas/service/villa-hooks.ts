import type { Prisma } from "../../../generated/prisma/client.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";

// What an update of a villa tells the code that reacts to it. Only a change of the villa's contractor is announced: the
// contractor was set, replaced or cleared.
export type ContractorChange = {
  villaId: string;
  before: string | null;
  after: string | null;
  actor: Actor;
  ctx: RequestContext;
};

// HOOK FOR THE OPEN WORKS: each function in this list runs inside the transaction of every villa update that changed
// the contractor, after the villa is written (its row is locked since the start) and before the audit entry, with the
// transaction's client. The open works register here to hand their automatic items to the new contractor. A hook that
// throws undoes the whole update. Nothing in the villas imports the open works: they register themselves at startup.
export type ContractorChangeHook = (tx: Prisma.TransactionClient, change: ContractorChange) => Promise<void>;
export const contractorChangeHooks: ContractorChangeHook[] = [];
