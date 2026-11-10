import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { ElecPhasesService } from "../service/elec-phases.service.js";
import type {
  CreateElecPhaseInput,
  ListElecPhasesQuery,
  ReorderElecPhasesInput,
  UpdateElecPhaseInput,
} from "../validators/elec-phases.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class ElecPhasesController {
  constructor(private readonly service = new ElecPhasesService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListElecPhasesQuery);
    res.status(200).json({ data: items, meta });
  };

  options = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.options() });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const phase = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, phase.version);
    res.status(200).json({ data: phase });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const phase = await this.service.create(actorOf(req), req.body as CreateElecPhaseInput, contextOf(req));
    res.status(201).json({ data: phase });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const phase = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateElecPhaseInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, phase.version);
    res.status(200).json({ data: phase });
  };

  reorder = async (req: Request, res: Response): Promise<void> => {
    const phases = await this.service.reorder(
      actorOf(req),
      req.body as ReorderElecPhasesInput,
      contextOf(req),
    );
    res.status(200).json({ data: phases });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
