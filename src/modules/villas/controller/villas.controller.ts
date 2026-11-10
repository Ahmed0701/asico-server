import type { MewStatesInput } from "../validators/villas.validators.js";
import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { VillasService } from "../service/villas.service.js";
import type { CreateVillaInput, ListVillasQuery, UpdateVillaInput } from "../validators/villas.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class VillasController {
  constructor(private readonly service = new VillasService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListVillasQuery);
    res.status(200).json({ data: items, meta });
  };

  options = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.options() });
  };

  filters = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.filters() });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.create(actorOf(req), req.body as CreateVillaInput, contextOf(req));
    res.status(201).json({ data: villa });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateVillaInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  markMewFollowUp = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.markMewFollowUp(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  undoMewFollowUp = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.undoMewFollowUp(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  markMewInspection = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.markMewInspection(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  undoMewInspection = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.undoMewInspection(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  markMewInspectionPassed = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.markMewInspectionPassed(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  undoMewInspectionPassed = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.undoMewInspectionPassed(
      actorOf(req),
      idOf(req),
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  setMewStates = async (req: Request, res: Response): Promise<void> => {
    const villa = await this.service.setMewStates(
      actorOf(req),
      idOf(req),
      req.body as MewStatesInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, villa.version);
    res.status(200).json({ data: villa });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
