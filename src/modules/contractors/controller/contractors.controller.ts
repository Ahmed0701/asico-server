import type { Request, Response } from "express";
import { setVersionHeaders } from "../../../core/concurrency/version.js";
import { actorOf, contextOf } from "../../../core/middleware/requestContext.js";
import { ContractorsService } from "../service/contractors.service.js";
import type {
  ContractorSummaryQuery,
  CreateContractorInput,
  ListContractorsQuery,
  UpdateContractorInput,
} from "../validators/contractors.validators.js";

function idOf(req: Request): string {
  return (req.validated.params as { id: string }).id;
}

export class ContractorsController {
  constructor(private readonly service = new ContractorsService()) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, meta } = await this.service.list(req.validated.query as ListContractorsQuery);
    res.status(200).json({ data: items, meta });
  };

  options = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ data: await this.service.options() });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const contractor = await this.service.get(idOf(req), contextOf(req));
    setVersionHeaders(res, contractor.version);
    res.status(200).json({ data: contractor });
  };

  // `meta` sits beside `data`, like every other list, so a generic list helper reads it unchanged.
  summary = async (req: Request, res: Response): Promise<void> => {
    const { summary, meta } = await this.service.summary(
      idOf(req),
      req.validated.query as ContractorSummaryQuery,
      contextOf(req),
      req.user,
    );
    res.status(200).json({ data: summary, meta });
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const contractor = await this.service.create(
      actorOf(req),
      req.body as CreateContractorInput,
      contextOf(req),
    );
    res.status(201).json({ data: contractor });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const contractor = await this.service.update(
      actorOf(req),
      idOf(req),
      req.body as UpdateContractorInput,
      contextOf(req),
      req.expectedVersion,
    );
    setVersionHeaders(res, contractor.version);
    res.status(200).json({ data: contractor });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    await this.service.remove(actorOf(req), idOf(req), contextOf(req), req.expectedVersion);
    res.status(204).end();
  };
}
