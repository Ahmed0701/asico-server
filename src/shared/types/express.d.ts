import type { Role } from "../../generated/prisma/client.js";
import type { LocaleCode } from "../constants/enums.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      locale: LocaleCode;
      validated: {
        query?: unknown;
        params?: unknown;
      };
      // The version named in If-Match, when there is one (see core/concurrency/version.ts).
      expectedVersion?: number;
      user?: {
        id: string;
        role: Role;
      };
    }
  }
}
