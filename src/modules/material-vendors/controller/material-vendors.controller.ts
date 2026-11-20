import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { MaterialVendorsService } from "../service/material-vendors.service.js";
import type {
  ListVillaVendorsQuery,
  PutVillaVendorsInput,
} from "../validators/material-vendors.validators.js";

export class MaterialVendorsController {
  constructor(private readonly service = new MaterialVendorsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, summary } = await this.service.list(req.validated.query as ListVillaVendorsQuery);
    res.status(200).json({ data: items, meta, summary });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const item = await this.service.get(villaId, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };

  available = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.available() });
  };

  add = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const item = await this.service.add(actorOf(req), villaId, contextOf(req));
    setVersionHeaders(res, item.version);
    res.status(201).json({ data: item });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    await this.service.remove(actorOf(req), villaId, contextOf(req), req.expectedVersion);
    res.status(204).end();
  };

  assign = async (req: Request, res: Response): Promise<void> => {
    const { villaId } = req.validated.params as { villaId: string };
    const item = await this.service.assign(
      actorOf(req),
      villaId,
      req.body as PutVillaVendorsInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, item.version);
    res.status(200).json({ data: item });
  };
}
