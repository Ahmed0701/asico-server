import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { OverheadService } from "../service/overhead.service.js";
import type {
  CreateOverheadInput,
  ListOverheadQuery,
  UpdateOverheadInput,
} from "../validators/overhead.validators.js";

const idOf = (req: Request): string => (req.validated.params as { id: string }).id;

export class OverheadController {
  constructor(private readonly service = new OverheadService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, totals } = await this.service.list(req.validated.query as ListOverheadQuery);
    res.status(200).json({ data: items, meta, totals });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.create(actorOf(req), req.body as CreateOverheadInput, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateOverheadInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
