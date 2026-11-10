import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { VillaProgressService } from "../service/villa-progress.service.js";
import type { UpdatePhaseProgressInput, VillaPhaseParams } from "../validators/villa-progress.validators.js";

export class VillaProgressController {
  constructor(private readonly service = new VillaProgressService()) {}

  update = async (req: Request, res: Response): Promise<void> => {
    const { villaId, elecPhaseId } = req.validated.params as VillaPhaseParams;
    const result = await this.service.update(
      actorOf(req),
      villaId,
      elecPhaseId,
      req.body as UpdatePhaseProgressInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, result.version);
    res.status(200).json({ data: result });
  };
}
