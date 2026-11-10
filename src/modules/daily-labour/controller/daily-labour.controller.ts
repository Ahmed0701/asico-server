import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { DailyLabourService } from "../service/daily-labour.service.js";
import type {
  CreateDailyLabourInput,
  ListDailyLabourQuery,
  UpdateDailyLabourInput,
} from "../validators/daily-labour.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class DailyLabourController {
  constructor(private readonly service = new DailyLabourService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListDailyLabourQuery);
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const labour = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, labour.version);
    res.status(200).json({ data: labour });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const labour = await this.service.create(
      actorOf(req),
      req.body as CreateDailyLabourInput,
      contextOf(req),
    );
    setVersionHeaders(res, labour.version);
    res.status(201).json({ data: labour });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const labour = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateDailyLabourInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, labour.version);
    res.status(200).json({ data: labour });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
