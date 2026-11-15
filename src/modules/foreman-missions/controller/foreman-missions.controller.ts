import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { ForemanMissionsService } from "../service/foreman-missions.service.js";
import type {
  CreateForemanMissionInput,
  ListForemanMissionsQuery,
  UpdateForemanMissionInput,
} from "../validators/foreman-missions.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class ForemanMissionsController {
  constructor(private readonly service = new ForemanMissionsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListForemanMissionsQuery);
    res.status(200).json({ data: items, meta });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.create(
      actorOf(req),
      req.body as CreateForemanMissionInput,
      contextOf(req),
    );
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const item = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateForemanMissionInput,
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
