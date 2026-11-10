import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { AreasService } from "../service/areas.service.js";
import type { CreateAreaInput, ListAreasQuery, UpdateAreaInput } from "../validators/areas.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class AreasController {
  constructor(private readonly service = new AreasService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListAreasQuery);
    res.status(200).json({ data: items, meta });
  };

  options = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.options() });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const area = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, area.version);
    res.status(200).json({ data: area });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const area = await this.service.create(actorOf(req), req.body as CreateAreaInput, contextOf(req));
    res.status(201).json({ data: area });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const area = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateAreaInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, area.version);
    res.status(200).json({ data: area });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
