import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { SmallWorksService } from "../service/small-works.service.js";
import type {
  CreateSmallWorkInput,
  ListSmallWorksQuery,
  UpdateSmallWorkInput,
} from "../validators/small-works.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class SmallWorksController {
  constructor(private readonly service = new SmallWorksService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListSmallWorksQuery);
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const work = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, work.version);
    res.status(200).json({ data: work });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const work = await this.service.create(actorOf(req), req.body as CreateSmallWorkInput, contextOf(req));
    setVersionHeaders(res, work.version);
    res.status(201).json({ data: work });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const work = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateSmallWorkInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, work.version);
    res.status(200).json({ data: work });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
