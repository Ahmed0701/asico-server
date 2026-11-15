import type { Request, Response } from "express";
import { contextOf } from "../../../core/middleware/requestContext.js";
import { MonthlyProgressService } from "../service/monthly-progress.service.js";
import type { MonthlyProgressQuery } from "../validators/monthly-progress.validators.js";

export class MonthlyProgressController {
  constructor(private readonly service = new MonthlyProgressService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, summary } = await this.service.list(
      req.validated.query as MonthlyProgressQuery,
      contextOf(req),
    );
    res.status(200).json({ data: items, meta, summary });
  };
}
