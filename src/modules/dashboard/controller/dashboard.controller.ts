import type { Request, Response } from "express";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { contextOf } from "../../../core/middleware/requestContext.js";
import { DashboardService } from "../service/dashboard.service.js";
import type { RecentActivityQuery } from "../validators/dashboard.validators.js";

export class DashboardController {
  constructor(private readonly service = new DashboardService()) {}

  summary = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");
    }
    res.status(200).json({ data: await this.service.summary(req.user) });
  };

  recentActivity = async (req: Request, res: Response): Promise<void> => {
    const { limit } = req.validated.query as RecentActivityQuery;
    res.status(200).json({ data: await this.service.recentActivity(limit, contextOf(req)) });
  };
}
