import type { Request, Response } from "express";
import { contextOf } from "../../../core/middleware/requestContext.js";
import { AuditService } from "../service/audit.service.js";
import type { ListAuditLogsQuery } from "../validators/audit.validators.js";

export class AuditController {
  constructor(private readonly service = new AuditService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(
      req.validated.query as ListAuditLogsQuery,
      contextOf(req),
    );
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.validated.params as { id: string };
    res.status(200).json({ data: await this.service.get(id, contextOf(req)) });
  };

  filters = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.filters(contextOf(req)) });
  };
}
