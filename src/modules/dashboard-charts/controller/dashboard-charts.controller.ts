import type { Request, Response } from "express";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import { DashboardChartsService } from "../service/dashboard-charts.service.js";

export class DashboardChartsController {
  constructor(private readonly service = new DashboardChartsService()) {}

  charts = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError(401, t(req.locale, "errors.unauthorized"), "UNAUTHORIZED");
    }
    res.status(200).json({ data: await this.service.charts(req.user) });
  };
}
