import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";
import { currentVillaScope } from "../scope/villa-scope.js";

// Must run after `auth` (which sets the villa scope): a user linked to an electrical engineer is refused, whatever it was
// granted. Used for the villa's money (its budget, the Monthly Payments, the payment history), which an engineer never sees.
export function denyEngineerScope(req: Request, _res: Response, next: NextFunction): void {
  if (currentVillaScope()) {
    next(new AppError(403, t(req.locale, "errors.villaBudgetByEngineer"), "FORBIDDEN"));
    return;
  }
  next();
}
