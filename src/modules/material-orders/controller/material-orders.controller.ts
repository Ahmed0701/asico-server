import type { Request, Response } from "express";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { MaterialOrdersService } from "../service/material-orders.service.js";
import type {
  ListMaterialOrdersQuery,
  SetMaterialOrderInput,
} from "../validators/material-orders.validators.js";

export class MaterialOrdersController {
  constructor(private readonly service = new MaterialOrdersService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta, summary } = await this.service.list(req.validated.query as ListMaterialOrdersQuery);
    res.status(200).json({ data: items, meta, summary });
  };

  set = async (req: Request, res: Response): Promise<void> => {
    const { villaId, type } = req.validated.params as { villaId: string; type: FactoryTypeValue };
    const row = await this.service.set(
      actorOf(req),
      villaId,
      type,
      req.body as SetMaterialOrderInput,
      contextOf(req),
    );
    res.status(200).json({ data: row });
  };
}
