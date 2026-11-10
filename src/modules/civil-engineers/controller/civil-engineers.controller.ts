import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { CivilEngineersService } from "../service/civil-engineers.service.js";
import type {
  CreateCivilEngineerInput,
  ListCivilEngineersQuery,
  UpdateCivilEngineerInput,
} from "../validators/civil-engineers.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class CivilEngineersController {
  constructor(private readonly service = new CivilEngineersService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListCivilEngineersQuery);
    res.status(200).json({ data: items, meta });
  };

  options = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.options() });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const engineer = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, engineer.version);
    res.status(200).json({ data: engineer });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const engineer = await this.service.create(
      actorOf(req),
      req.body as CreateCivilEngineerInput,
      contextOf(req),
    );
    res.status(201).json({ data: engineer });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const engineer = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateCivilEngineerInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, engineer.version);
    res.status(200).json({ data: engineer });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
