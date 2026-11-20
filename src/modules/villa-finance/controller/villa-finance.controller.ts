import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { VillaFinanceService } from "../service/villa-finance.service.js";
import type { ListVillaFinanceQuery, PutVillaFinanceInput } from "../validators/villa-finance.validators.js";

const villaIdOf = (req: Request): string => (req.validated.params as { villaId: string }).villaId;

export class VillaFinanceController {
  constructor(private readonly service = new VillaFinanceService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, summary } = await this.service.list(req.validated.query as ListVillaFinanceQuery);
    res.status(200).json({ data: items, meta, summary });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.get(villaIdOf(req), contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  put = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.update(
      actorOf(req),
      villaIdOf(req),
      req.body as PutVillaFinanceInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };
}
